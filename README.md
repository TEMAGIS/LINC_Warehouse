# LINC Warehouse

A mobile-friendly console for **receiving, moving and shipping** warehouse inventory, built the same way as the Assigned Inventory Console: a static site (no build step), ArcGIS Online sign-in (OAuth + PKCE), `shared/` files copied from TEMAzon, dialogs for the everyday jobs, tabs along the top. It works on the **existing** layers: Transactions, Inventory Balance and the Barcode Library.

## What it does

| Job | How |
|---|---|
| **Receive** | Scan the item, enter the quantity, scan the put-away location. The unit ("Case of 24") and approximate gallons come from the Barcode Library. |
| **Not in the library?** | Scanning an unknown barcode offers **Add to library** on the spot (category, item, make, model, size, pack/volume, photo). The new item is selected and ready to receive, and is there next time. No photo? Tick "Add the photo later" and a gray UPLOAD IMAGE card is attached as a placeholder. |
| **Move** | Scan the From location, tick what to move and how many, scan the To location. Also on every Stock row. |
| **Stage to pick line** | Choose an item, enter the total, and **Fill from oldest stock** spreads it across the shelves holding it (oldest `last_update` first). One Move per source shelf. |
| **Ship** | Only from the **Pick line** tab, through a **shipment plan**: recipient, ship-to location (name, address), order reference, requested date, and the pick-line items going out. Save as Draft, mark Ready, print a pick sheet, **Ship now** writes one Ship transaction per line. |
| **Library** | The Barcode Library as a searchable list (item, barcode, category, unit, gallons, on hand) with **Add item** (the same form the scanner uses), **Edit**, and **Flag for delete**, so the Survey123 library form isn't needed. Flagging never deletes: the record stays, marked `delete_flag = Yes` with reason, who and when, and is hidden from the list and item pickers until you tick "Flagged for delete" and **Restore** it. Stock and transaction history keep working. Everything needs Editing turned on for the Barcode Library item in ArcGIS Online; otherwise the tab shows a read-only notice. |
| **Transactions** | The latest transactions from anywhere (this app or the Survey123 form) with status. **Retry** on anything Pending or in Error. CSV export. |
| **Settings** | Administrators: the **ArcGIS items the app uses and who each is shared with** (with what your own account can do and, when it can't edit, the likely reason), property owner groups, schema checks and "Add missing fields", create the shipments service, webhook and pick-line status. |

## The pick line

The pick line is a reserved **zone code, `PL`**. Each lane is one location in that zone:

`PL` + lane + `01` + `01` + `01` → lane 1 is **`PL01010101`** (shown as `PL-01-01-01-01`).

It starts with **one lane**. To add lanes, raise `PICKLINE.LANES` in `config.js` (lane 2 = `PL02010101`, …). The lane picker in Stage appears automatically once there's more than one. No layer changes are needed, since `PL` is just another zone value. Print a location label for each lane.

**Ship is only possible from the pick line.** The app refuses it. While the Survey123 form is still in use, the webhook Lambda enforces the same rule for the form (setup step 4).

## How a change reaches inventory

1. The app adds a row to the **Transactions** layer, filling the same fields the Survey123 form fills.
2. It applies the change to **Inventory Balance** itself (`balance.js`), with the signed-in person's account, then marks the transaction **Success** (or **Error** with the reason).
3. It reloads balances.

`balance.js` is a port of the webhook Lambda's rules: every leg is checked before anything is written; a leg that would go negative, or has no stock to take from, rejects the whole transaction; a Move's two balance rows are written in **one** `applyEdits` call (both or neither); rows are matched on site + item + location + lot with NULL-safe clauses, so a blank zone or lot never creates a duplicate row; Ship only from the pick line.

- **Safe to retry.** The transaction id is stamped on the balance row (`last_transaction_id`), so re-applying a transaction that already went through is a no-op. Pending / Error rows have a **Retry** on the Transactions tab.
- **No webhook needed.** `APPLY_MODE: "webhook"` in `config.js` switches back to calling the Lambda if you ever want that.
- **Known limit.** Applying reads the balance row, then writes it. Two people changing the *same* balance row in the same second can overwrite each other (ArcGIS has no conditional update). Lines within one action are written one at a time, so a single user can't collide with themselves. If this turns up in practice, the fix is a re-read-and-compare just before the write.
- **The Lambda rules aren't enforced on the server for this app.** The pick-line rule lives in the app. Anyone with edit access to the layers can still change them directly in ArcGIS Online.

## Shipment plans

Plans live in a small hosted service the app creates (**Settings → Create the shipments service**, needs a publisher account): `Shipments` (one row per plan), `Shipment_Lines` and `Users`. If the service already exists without Users, **Settings → Add the Users table** adds it (use the account that owns the service). Nothing in a plan changes inventory until you **Ship**. Open plans count as *Promised*, so the same pick-line stock can't be promised twice (**Available = On hand − Promised**).

## Users and roles

Only people on the **warehouse user list** can open the app. The list is the `Users` table in the shipments service, managed on the **Users** tab (administrators only): add a person (search the **TEMA Warehouse LINC Admins** ArcGIS group, `MEMBER_GROUP_ID` in `config.js`, to prefill name, email and username; clear it to search the whole organization), change role, turn access off, or remove them. The app refuses to remove, demote or deactivate the **last active administrator**.

| | Administrator | Staff | View only |
|---|---|---|---|
| View stock, transactions, plans | yes | yes | yes |
| Receive, Move, Stage, plans, Ship, add to library | yes | yes | no |
| Retry a failed transaction | yes | yes | no |
| **Void** a transaction that can never apply | yes | no | no |
| Users and Settings tabs | yes | no | no |

- Not on the list (or turned off): the "No access yet" screen.
- **First administrator.** While the list has no active administrator, an Inventory Administrator from the Assigned Inventory **Users** layer (`permissions = Property Officer`, matched by email) gets in as Administrator and is added to the list automatically.
- **Before the Users table exists** (Settings shows "Add the Users table"), the app behaves as before: that legacy administrator is an Administrator, everyone else Staff.
- **Roles don't grant ArcGIS rights.** The role decides what the app offers. What an account can actually write is set by ArcGIS sharing. Staff need edit access to the Transactions and Inventory Balance layers. If a role allows editing but the account can't, the app shows "view only" and says why. The fix is in ArcGIS Online: turn on **Editing** for the Inventory Balance item and share it with a group whose members can update.

## Property owners (groups that manage their own consumables)

Some consumables are received and managed by different groups. Every stock row and transaction records a **property owner** (`property_owner`, the owner's code). The same item on the same shelf and lot owned by two groups is kept as **two** Inventory Balance rows, so counts never mix.

- **The list** lives in the `Owners` table of the shipments service, edited in **Settings → Property owners** (add, rename, remove). Each group gets a stable code; renaming is safe.
- **People** are tied to groups on the **Users** tab (Edit person → *Property owner of*, stored in `property_owner_of`). *Group staff* can receive, move, stage and ship **only** their groups' stock. Administrators, and staff with no group ticked, can handle everything. Everyone can still *view* all stock (ArcGIS sharing is what truly restricts access).
- **Receive** asks for the owner (group staff must pick one of theirs; others may leave it as "No owner"). Move, Stage and Ship carry the stock's owner; a shipment plan line remembers it.
- **Existing stock** has no owner. An administrator gives it one from the Stock tab (**Owner** button on a row). That edits the balance row directly and is *not* logged as a transaction; if that owner already has a row for the same item/shelf/lot, the quantities are merged.
- **Dormant until set up.** Owners only switch on when the Owners table, the `property_owner` fields (Inventory Balance, Transactions, Shipment lines), the Users `property_owner_of` field and at least one group exist; Settings shows each step as ✓/✗. Until then the app behaves exactly as before. **Settings → Add all missing fields** adds the fields; **Add the Owners table** adds the table. Both need the account that owns the layers/service (or an org administrator). Survey123-published Transactions: add `property_owner` to the survey too.
- **Not covered:** `APPLY_MODE: "webhook"` and the old Survey123 form don't know about owners, so what they write has no owner.

## Settings: ArcGIS items and sharing

The first card lists each ArcGIS Online item the app uses (Inventory Balance, Transactions, Barcode Library, the shipments service, the Assigned Inventory Users layer): item ID, type and owner, the groups it is shared with (marked *members can edit* for shared update groups, and whether you are in them), and **what your account can do today** (from the layer's own capabilities). It also checks that each item ID is really the layer the app reads, shows your ArcGIS user type and whether your role includes **Edit features**, and the "Add person" group. *Applying to inventory* turns a red "can't edit Inventory Balance" into the likely causes: a role without Edit features, the item not shared with a shared update group, you not being in that group, or editing switched off on the item/view. Nothing there changes sharing; that is done in ArcGIS Online. `USERS_ITEM_ID` in `config.js` is the Assigned Inventory Users item (only used for this display).

## Voiding a stuck transaction

Some Error transactions can never apply (for example a bad quantity from the old form). Retry won't fix them. An administrator can **Void** one with a reason: it is set to `processing_status = Voided`, inventory is untouched, it drops out of the "not applied" count, and Retry is no longer offered. The reconcile and webhook Lambdas skip `Voided` rows (redeploy `reconcile_inventory.py` and `webhook_apply_transaction.py` if you still use them).

## Setup checklist

1. **Host it.** New repo/site `LINC_Warehouse` on GitHub Pages: `https://temagis.github.io/LINC_Warehouse/`.
2. **OAuth.** It reuses the Lookup page's OAuth app (`ARCGIS_APP_ID` in `config.js`). Add `https://temagis.github.io/LINC_Warehouse/` as a **Redirect URI** on that app, trailing slash included. (Or register a new app and replace the ID.)
3. **Sharing.** Warehouse staff need **edit** access to the Transactions and Inventory Balance layers (and the Barcode Library to add items). Everyone else gets view-only.
4. **Webhook Lambda (only while the Survey123 form is still in use).** Redeploy `lambda_functions/webhook_apply_transaction.py` so the form can't ship from a shelf either: env vars `PICKLINE_ZONE` (default `PL`) and `ENFORCE_PICKLINE_SHIP` (default `1`). The console doesn't need it. Retire the Lambda when the form is retired.
5. **Fields.** Easiest: **Settings → Add all missing fields** (as the account that owns the layers, or an org admin). It adds only what's missing: Transactions `shipment_id`, `ship_to`, `unit_of_measure`, `processing_*`, `processed_at`, `inventory_balance_gids`; Inventory Balance `last_transaction_id`, `quantity_available`, `unit_of_measure`, `item`; Barcode Library `count_unit`, `units_per_pack`, `unit_volume`, `unit_volume_uom`, `gallons_per_count_unit`, `delete_flag`, `delete_reason`, `flagged_by`, `flagged_date`. Survey123-published layers: add the same fields to the survey too, or republishing can remove them. Manual alternative for Transactions: **two optional fields** so shipments are traceable: `shipment_id` (text 50) and `ship_to` (text 255). Add them to the Transactions survey and republish, or add them in ArcGIS Online. The app fills them only if they exist.
6. **Barcode Library:** (covered by the button above) otherwise republish the updated survey so `count_unit`, `units_per_pack`, `unit_volume`, `unit_volume_uom` and `gallons_per_count_unit` exist (until then, items are added without pack/unit details and the app tells you).
7. **Settings → Create the shipments service** (or **Add the Users table** if it exists), then **share it** with the same group as the inventory layers with **editing on**. Then open **Users** and add your people. Optionally paste its item ID into `SHIPMENTS_ITEM_ID`.
8. Open **Settings** and read the field checks; the console also logs missing fields.

## Files

```
index.html  app.css  app.js  config.js  lists.js
state.js  data.js  loc.js  units.js  txn.js  balance.js
widgets.js  scanner.js  library.js  dialogs.js  users.js  schemafix.js  libtab.js
stock.js  pickline.js  shipments.js  transactions.js  settings.js  items.js  owners.js
shared/  arcgis-auth.js  esri-client.js  session.js  ui.js  util.js  common.css   (TEMAzon's shared files)
```

`lists.js` holds the dropdown lists copied from the Barcode Library survey (categories, items, units). Update it when the survey's lists change.

## Location codes

Same scheme as the Transactions survey: 2 characters per segment (zone, row, bay, level, position), zone left off when there is none (8 characters instead of 10). Scan or type with or without dashes.

## What was tested, and what wasn't

Tested in Node against a **mock** ArcGIS service (about 130 checks): location parsing and labels, units and gallons, validation (overdraw, running balance across lines, same location, Ship from storage), sequential staging from two shelves to one pick-line row, Ship from the pick line, server-side rejection, the full dialogs in a simulated browser (Stage, Receive, Receive-unknown-barcode → Add to library → continue, shipment plan from draft to shipped), plan and line saving, stock / transaction filters, app start-up for an Inventory Administrator and for a view-only account.

**Not verified against your live ArcGIS org:**

- **Creating the shipments service** (`createService` + `addToDefinition`) follows the Assigned Inventory Console's calls, which haven't run against your org either. If it fails the dialog shows ArcGIS's error.
- **Balance edits from the browser.** The first Receive is the real test: it needs your account to be able to add/update rows in Inventory Balance (Settings shows whether it can). Check the new balance row afterwards: location fields, `quantity_available`, `last_transaction_id`.
- **Staff detection.** Staff are recognised by the Transactions and Balance layers' `capabilities` including Create/Update/Editing for the signed-in account. If a staff member shows as view-only, check the Transactions layer's sharing/editing settings.
- **Adding library items without a map point.** New items are added without geometry. If the layer rejects that, tell me and I'll add a default point.
- **Camera scanning** needs HTTPS and a phone/tablet camera; hardware scanners that type into the box and press Enter work without it.
- The **gray placeholder image** is drawn in the browser; it wasn't rendered on a real device.

## A separate mobile app later

The pieces that matter are plain modules with no framework and little DOM: `loc.js` (location codes), `units.js`, `balance.js` and `txn.js` (writing transactions and applying them), `shipments.js`, `library.js` / `lists.js` (adding library items), `scanner.js`. A phone-first app that replaces the Survey123 form can import them as they are and bring only its own screens, so the rules stay identical in both.
