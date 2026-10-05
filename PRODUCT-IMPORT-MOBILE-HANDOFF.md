# Mobile handoff for bulk product import — NOT SHIPPED

Bulk uploads and connected shops are managed on the website only. The app gets one small pointer, **after** the web
importer has been accepted and deployed, and **not** while build 146 is in Apple review (no OTA, no native build for this).

- **File:** `app/business-products.tsx`
- **Where:** a compact card near the top of the product list (and in the empty state)
- **Copy (approved, verbatim):**
  - Title: `Need to add lots of products?`
  - Body: `Bulk uploads and connected shops are managed on the OneShetland website.`
  - Action: `Manage products on the web →`
- **Destination:** `https://oneshetland.com/business/{businessId}/manage/products` (open in the system browser; the web
  sign-in now returns the owner to exactly that page).
- **Do not** add import UI, CSV handling or connector setup to the app.
- **Compatibility already proven** for builds that do not know about import: the app only writes title, description,
  category, price, photos, stock mode/stock, lead time, collect/free-post flags, is_active and variant name/delta/stock/
  position/is_active. It never writes `reserved`, `sold_at` or the new provenance columns, which clients may no longer write.
  Editing an imported product from the app locks the edited fields against later imports, exactly as on the web.
