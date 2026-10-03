-- Apply once to existing installations before deploying the updated checkout.
alter table public.order_items add column if not exists size text not null default 'Small'
  check (size in ('Small','Medium','Large','XL'));

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

