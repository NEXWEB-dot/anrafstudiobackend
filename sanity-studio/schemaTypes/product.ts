import {defineArrayMember, defineField, defineType} from 'sanity'
import {TagIcon} from '@sanity/icons/Tag'

export const product = defineType({
  name: 'product',
  title: 'Product',
  type: 'document',
  icon: TagIcon,
  fields: [
    defineField({name: 'name', type: 'string', validation: (r) => r.required().max(200)}),
    defineField({
      name: 'slug', type: 'slug', options: {source: 'name', maxLength: 96},
      validation: (r) => r.required().custom((v) => !v?.current || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.current) || 'Use lowercase letters, numbers and hyphens.'),
    }),
    defineField({name: 'description', type: 'text', rows: 6, validation: (r) => r.max(5000)}),
    defineField({name: 'price', title: 'Price before discount (PKR)', type: 'number', validation: (r) => r.required().min(1).max(10000000).precision(2)}),
    defineField({
      name: 'discountPercent', title: 'Discount (%)', type: 'number', initialValue: 0,
      description: 'For example, 20 gives 20% off the price above. Set to 0 for no discount.',
      validation: (r) => r.min(0).max(99).integer().custom((value, ctx) =>
        value == null || Math.round(Number(ctx.document?.price) * (100 - value)) >= 100 || 'The discounted price must be at least PKR 1.'),
    }),
    defineField({
      name: 'compareAtPrice', title: 'Original price (PKR)', type: 'number',
      description: 'Alternative to a percentage discount: enter an original price and use Price above as the selling price. Leave empty when using Discount (%).',
      validation: (r) => r.min(1).max(10000000).precision(2).custom((v, ctx) => v == null || (Number(ctx.document?.discountPercent || 0) > 0 ? 'Clear this field when using Discount (%).' : v > Number(ctx.document?.price) || 'Must exceed the selling price.')),
    }),
    defineField({name: 'category', type: 'string', options: {list: ['Embroidered', 'Lawn', 'Heritage', 'Ready to Wear']}, validation: (r) => r.required()}),
    defineField({
      name: 'filters', title: 'Storefront filters', type: 'array',
      description: 'Choose every collection filter this product should appear under. All products also appear under All. If left empty, the category is used.',
      of: [defineArrayMember({type: 'string'})],
      options: {list: ['Embroidered', 'Lawn', 'Heritage', 'Ready to Wear'], layout: 'grid'},
      validation: (r) => r.unique(),
    }),
    defineField({
      name: 'sizes', title: 'Available sizes', type: 'array', initialValue: ['Small', 'Medium', 'Large', 'XL'],
      description: 'Select only the sizes customers can order. Remove a size when it is unavailable.',
      of: [defineArrayMember({type: 'string'})],
      options: {list: ['Small', 'Medium', 'Large', 'XL'], layout: 'grid'},
      validation: (r) => r.required().min(1).unique(),
    }),
    defineField({
      name: 'availability', title: 'Stock status / Sold out', type: 'string', initialValue: 'in-stock',
      description: 'Update this manually when sold out. Orders do not automatically reduce inventory in Sanity.',
      options: {list: [{title: 'In stock', value: 'in-stock'}, {title: 'Sold out', value: 'sold-out'}], layout: 'radio'},
      validation: (r) => r.required(),
    }),
    defineField({name: 'isActive', title: 'Show in storefront', type: 'boolean', initialValue: true, validation: (r) => r.required()}),
    defineField({name: 'sortOrder', title: 'Display order', type: 'number', initialValue: 0, validation: (r) => r.integer().min(0)}),
    defineField({
      name: 'images', title: 'Gallery images', type: 'array',
      description: 'Add up to 8 photos. Drag to reorder: the first is the main product image, the second is the hover image, and all appear in the product gallery.',
      validation: (r) => r.required().min(1).max(8),
      of: [defineArrayMember({type: 'image', options: {hotspot: true}, validation: (r) => r.required().assetRequired(), fields: [
        defineField({name: 'alt', title: 'Image description', type: 'string', validation: (r) => r.required().max(200)}),
      ]})],
    }),
  ],
  orderings: [{title: 'Display order', name: 'displayOrder', by: [{field: 'sortOrder', direction: 'asc'}]}],
  preview: {select: {title: 'name', subtitle: 'category', media: 'images.0'}},
})
