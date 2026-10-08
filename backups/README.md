# Product catalog backup

sanity.snapshot.json is a normalized snapshot of published storefront products.
It includes product information and Sanity CDN image URLs, not image binaries,
drafts, order records, or a complete restorable export of the Sanity dataset.

Run `node scripts/backup-products.mjs` to refresh the snapshot, review the changes,
then commit it. The backup is not served publicly by the backend build and is not
used by checkout. Product images can be kept separately in ../assets/.
