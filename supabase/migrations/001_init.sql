-- supabase/migrations/001_init.sql
-- Run this migration in the Supabase SQL editor.
-- After running, verify with the anon key:
--   GET /rest/v1/orders, GET /rest/v1/products, POST /rest/v1/rpc/place_order
-- All three must fail with a permission error. If any succeeds, stop and fix RLS.

-- ---------- tables ----------
create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9-]{1,120}$'),
  name text not null check (char_length(name) between 1 and 200),
  description text check (char_length(description) <= 5000),
  price numeric(12,2) not null check (price >= 0),
  compare_at_price numeric(12,2) check (compare_at_price is null or compare_at_price >= 0),
  category text,
  track_stock boolean not null default false,   -- false = manual in/out-of-stock toggle only
  stock int not null default 0 check (stock >= 0),
  in_stock boolean not null default true,       -- manual toggle, always respected
  is_active boolean not null default true,      -- false = hidden from storefront
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on products (is_active, sort_order);
create index on products (category);

create table product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  r2_key text not null,          -- object key in PUBLIC bucket (used for deletion)
  url text not null,             -- public CDN URL (full size)
  thumb_r2_key text,
  thumb_url text,                -- ~400px thumbnail for listing pages
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on product_images (product_id, sort_order);

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity,   -- human-friendly number
  client_ref text unique,                             -- idempotency key from checkout page
  customer_name text not null,
  customer_phone text not null,
  customer_address text,
  notes text,
  status text not null default 'pending'
    check (status in ('pending','confirmed','shipped','delivered','cancelled')),
  total numeric(12,2) not null default 0,
  source text not null default 'online' check (source in ('online','offline_replay')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orders (status, created_at desc);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,                       -- snapshot: survives product deletion
  size text not null default 'Small' check (size in ('Small','Medium','Large','XL')),
  quantity int not null check (quantity between 1 and 50),
  price_at_purchase numeric(12,2) not null          -- snapshot: later price edits never rewrite history
);
create index on order_items (order_id);

-- ---------- updated_at ----------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger products_updated_at before update on products for each row execute function set_updated_at();
create trigger orders_updated_at   before update on orders   for each row execute function set_updated_at();

-- ---------- RLS: deny-all for browser roles ----------
alter table products       enable row level security;
alter table product_images enable row level security;
alter table orders         enable row level security;
alter table order_items    enable row level security;
-- Intentionally NO policies. Belt and braces: remove grants too.
revoke all on products, product_images, orders, order_items from anon, authenticated;


-- ========== CATALOG FUNCTIONS ==========

-- Public catalog: what shoppers see (no internal fields, no exact stock)
create or replace function catalog_public() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'count', (select count(*) from products where is_active),
    'version', 1,
    'generated_at', now(),
    'products', coalesce((
      select json_agg(json_build_object(
        'id', p.id, 'slug', p.slug, 'name', p.name, 'description', p.description,
        'price', p.price, 'compare_at_price', p.compare_at_price, 'category', p.category,
        'in_stock', (p.in_stock and (not p.track_stock or p.stock > 0)),
        'images', coalesce((select json_agg(json_build_object('url', i.url, 'thumb', i.thumb_url) order by i.sort_order)
                            from product_images i where i.product_id = p.id), '[]'::json)
      ) order by p.sort_order, p.created_at desc)
      from products p where p.is_active
    ), '[]'::json)
  );
$$;

-- Admin catalog: everything the dashboard needs (includes inactive, stock, R2 keys)
create or replace function catalog_admin() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'count', (select count(*) from products),
    'version', 1,
    'generated_at', now(),
    'products', coalesce((
      select json_agg(json_build_object(
        'id', p.id, 'slug', p.slug, 'name', p.name, 'description', p.description,
        'price', p.price, 'compare_at_price', p.compare_at_price, 'category', p.category,
        'track_stock', p.track_stock, 'stock', p.stock, 'in_stock', p.in_stock,
        'is_active', p.is_active, 'sort_order', p.sort_order,
        'images', coalesce((select json_agg(json_build_object(
            'r2_key', i.r2_key, 'url', i.url, 'thumb_r2_key', i.thumb_r2_key, 'thumb_url', i.thumb_url)
            order by i.sort_order) from product_images i where i.product_id = p.id), '[]'::json)
      ) order by p.sort_order, p.created_at desc)
      from products p
    ), '[]'::json)
  );
$$;

-- ========== TRANSACTIONAL FUNCTIONS ==========

-- Atomic order placement. Locks rows in id order (no deadlocks), validates stock,
-- takes prices from DB, decrements stock, inserts order + items.
-- p_force=true: used ONLY when replaying offline orders — never rejects, clamps stock at 0.
create or replace function place_order(
  p_client_ref text, p_name text, p_phone text, p_address text, p_notes text,
  p_items jsonb, p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_order orders%rowtype; v_total numeric(12,2) := 0; v_item jsonb; v_p products%rowtype;
  v_qty int; v_price numeric(12,2);
begin
  -- Idempotent: double-submit or replay returns the same order
  select * into v_order from orders where client_ref = p_client_ref;
  if found then
    return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                              'total', v_order.total, 'duplicate', true);
  end if;

  if (case when jsonb_typeof(p_items) = 'array' then jsonb_array_length(p_items) else 0 end) not between 1 and 30 then
    raise exception 'BAD_INPUT';
  end if;
  if char_length(coalesce(p_name,'')) not between 1 and 100
     or char_length(coalesce(p_phone,'')) not between 7 and 20 then
    raise exception 'BAD_INPUT';
  end if;

  insert into orders (client_ref, customer_name, customer_phone, customer_address, notes, source)
  values (p_client_ref, p_name, p_phone, p_address, p_notes,
          case when p_force then 'offline_replay' else 'online' end)
  returning * into v_order;

  for v_item in
    select t.value from jsonb_array_elements(p_items) as t(value) order by t.value->>'product_id'
  loop
    v_qty := (v_item->>'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'BAD_INPUT'; end if;

    select * into v_p from products where id = (v_item->>'product_id')::uuid for update;

    if not found or (not v_p.is_active and not p_force) then
      if p_force then
        -- Product gone since the offline order: keep the line as the customer saw it
        v_price := coalesce((v_item->>'price')::numeric, 0);
        insert into order_items (order_id, product_id, product_name, size, quantity, price_at_purchase)
        values (v_order.id, null, coalesce(v_item->>'name','unknown product'), coalesce(v_item->>'size','Small'), v_qty, v_price);
        v_total := v_total + v_price * v_qty;
        continue;
      end if;
      raise exception 'PRODUCT_UNAVAILABLE';
    end if;

    if not p_force then
      if not v_p.in_stock or (v_p.track_stock and v_p.stock < v_qty) then
        raise exception 'OUT_OF_STOCK' using detail = v_p.name;
      end if;
    end if;

    if v_p.track_stock then
      update products set stock = greatest(stock - v_qty, 0) where id = v_p.id;
    end if;

    v_price := case when p_force then coalesce((v_item->>'price')::numeric, v_p.price) else v_p.price end;
    insert into order_items (order_id, product_id, product_name, size, quantity, price_at_purchase)
    values (v_order.id, v_p.id, v_p.name, coalesce(v_item->>'size','Small'), v_qty, v_price);
    v_total := v_total + v_price * v_qty;
  end loop;

  update orders set total = v_total where id = v_order.id;
  return jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'total', v_total);
end $$;

-- Order status changes; cancelling restores stock. delivered/cancelled are terminal.
create or replace function set_order_status(p_order_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old text; r record;
begin
  select status into v_old from orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_old in ('delivered','cancelled') or v_old = p_status
     or not (
       (v_old = 'pending'   and p_status in ('confirmed','cancelled')) or
       (v_old = 'confirmed' and p_status in ('shipped','cancelled'))   or
       (v_old = 'shipped'   and p_status in ('delivered','cancelled')))
  then raise exception 'BAD_TRANSITION'; end if;

  if p_status = 'cancelled' then
    for r in select product_id, sum(quantity) as quantity from order_items where order_id = p_order_id and product_id is not null group by product_id order by product_id loop
      update products set stock = stock + r.quantity where id = r.product_id and track_stock;
    end loop;
  end if;
  update orders set status = p_status where id = p_order_id;
  return jsonb_build_object('order_id', p_order_id, 'status', p_status);
end $$;

-- Create-or-replace a product AND its image rows atomically.
create or replace function admin_upsert_product(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := coalesce((p->>'id')::uuid, gen_random_uuid()); img jsonb; i int := 0;
begin
  insert into products (id, slug, name, description, price, compare_at_price, category,
                        track_stock, stock, in_stock, is_active, sort_order)
  values (v_id, p->>'slug', p->>'name', p->>'description', (p->>'price')::numeric,
          nullif(p->>'compare_at_price','')::numeric, p->>'category',
          coalesce((p->>'track_stock')::boolean,false), coalesce((p->>'stock')::int,0),
          coalesce((p->>'in_stock')::boolean,true), coalesce((p->>'is_active')::boolean,true),
          coalesce((p->>'sort_order')::int,0))
  on conflict (id) do update set
    slug = excluded.slug, name = excluded.name, description = excluded.description,
    price = excluded.price, compare_at_price = excluded.compare_at_price, category = excluded.category,
    track_stock = excluded.track_stock, stock = excluded.stock, in_stock = excluded.in_stock,
    is_active = excluded.is_active, sort_order = excluded.sort_order;

  if p ? 'images' then
    delete from product_images where product_id = v_id;
    for img in select t.value from jsonb_array_elements(p->'images') as t(value) loop
      insert into product_images (product_id, r2_key, url, thumb_r2_key, thumb_url, sort_order)
      values (v_id, img->>'r2_key', img->>'url', img->>'thumb_r2_key', img->>'thumb_url', i);
      i := i + 1;
    end loop;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

-- Delete a product; returns its R2 keys so the caller can delete the objects.
create or replace function admin_delete_product(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_keys jsonb;
begin
  select coalesce(jsonb_agg(k), '[]'::jsonb) into v_keys from (
    select r2_key as k from product_images where product_id = p_id
    union select thumb_r2_key from product_images where product_id = p_id and thumb_r2_key is not null
  ) t;
  delete from products where id = p_id;
  return v_keys;
end $$;

-- Only the service role may call any of these functions.
revoke all on function catalog_public(), catalog_admin(), admin_delete_product(uuid),
  admin_upsert_product(jsonb), set_order_status(uuid, text),
  place_order(text, text, text, text, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function catalog_public(), catalog_admin(), admin_delete_product(uuid),
  admin_upsert_product(jsonb), set_order_status(uuid, text),
  place_order(text, text, text, text, text, jsonb, boolean) to service_role;
