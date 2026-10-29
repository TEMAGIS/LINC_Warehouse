// ---------------------------------------------------------------------------
// LINC Warehouse — configuration. Nothing here is secret: the OAuth client ID is
// a public identifier (PKCE, no client secret); real access control is ArcGIS
// Online sharing of the layers below plus the role rules in permissions.js.
//
// OAuth: this site reuses the LINC Lookup page's OAuth app. Add this site's
// address as a Redirect URI on that app (ArcGIS Online > Content > the app item >
// Settings > Registered Info), exactly as written below, trailing slash included.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- ArcGIS OAuth (authorization-code + PKCE) ---
  ARCGIS_PORTAL_URL: "https://www.arcgis.com",
  // "Add person" only offers members of this ArcGIS Online group (TEMA Warehouse LINC Admins). "" = whole organization.
  MEMBER_GROUP_ID: "4eb3824968984354b2dc7bea2be31f5f",
  ARCGIS_APP_ID: "FnhvYkFpFjKff2RT",
  ARCGIS_REDIRECT_URI: "https://temagis.github.io/LINC_Warehouse/",
  ARCGIS_TOKEN_EXPIRATION_MINUTES: 20160,
  ARCGIS_REFRESH_BUFFER_MS: 5 * 60 * 1000,
  ARCGIS_TOKEN_STORAGE_KEY: "linc_warehouse_arcgis_token_v1",

  // --- ArcGIS Online item IDs of the data (same layers the field app and Lookup page use) ---
  ITEM_IDS: {
    transactions: "4055a1a4b4914726b30cc59190249493", // LINC_Transactions (the EDITABLE view layer; was 3481accef6df444c8174272cb0363500; the old 6dfb43b5… item is a view-only copy)
    balance: "926007de266e40f691c12c7e1391437a",      // LINC Inventory Balance (the EDITABLE view layer; was d9c39c68… ; the old 812418a8… item is a view-only copy)
    library: "2d5dbbe0ec8e4f958aa20ed06ec505bc",      // Barcode Library (the EDITABLE layer; the old 426fb0b3… item is a view-only copy)
  },

  // View-only copies of the same layers. If an account can't open the editable item above (it isn't
  // shared with them), the app falls back to the view-only copy and runs read-only instead of locking
  // them out. Settings explains why. Remove an entry to turn the fallback off for that layer.
  VIEW_ITEM_IDS: {
    transactions: "6dfb43b544cb4d2bb4a13e2b1187b5f5",
    balance: "812418a81b474a4fbc2247d2fbd44061",
    library: "426fb0b37352474cbb6c38d5335e275b",
  },

  // Users layer of the Assigned Inventory Console. Only used to recognise Inventory
  // Administrators (permissions = "Property Officer") for the Settings tab.
  USERS_LAYER_URL:
    "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/service_9a64986429af4a56965e754b11fbcfba/FeatureServer/0",
  ADMIN_PERMISSION_VALUE: "Property Officer",
  // Item ID of that Users layer (Assigned Inventory "Users (editable)"). Only used by Settings to show its sharing.
  USERS_ITEM_ID: "72ec26c1f142418c83eba2a02ef2d2e7",
  USERS_EMAIL_FIELD: "email",
  USERS_PERMISSIONS_FIELD: "permissions",

  // --- Where stock lives ---
  SITE: "TEMA Central Warehouse", // default value of the `site` field on transactions / balances

  // --- Pick line -------------------------------------------------------------
  // The pick line is a reserved ZONE code. Each lane is one location in that zone:
  //   zone "PL", row = lane number, bay/level/position "01"  ->  scan code PL01010101
  // Start with ONE lane. To add lanes later, raise LANES (no data changes needed);
  // the lane picker appears in Stage and Shipment plans once LANES > 1.
  PICKLINE: { ZONE: "PL", LANES: 1 },

  // --- How a saved transaction reaches Inventory Balance ---
  //   "browser" (default): this app updates Inventory Balance itself (balance.js), using the
  //                        signed-in person's account. Staff need edit access to that layer.
  //   "webhook":           this app calls the webhook Lambda (WEBHOOK_URL) instead.
  APPLY_MODE: "browser",
  // Only used when APPLY_MODE is "webhook": full Lambda URL including ?x-api-key=...
  WEBHOOK_URL: "",

  // --- Shipment plans (header + lines) live in a small hosted service this app can create ---
  SHIPMENTS_SERVICE_TITLE: "LINC_Warehouse_Shipments",
  SHIPMENTS_ITEM_ID: "",
  SHIPMENTS_SERVICE_URL: "",


  // --- Behaviour ---
  LOW_STOCK: 5,
  TXN_FETCH_LIMIT: 1000,
  ROWS_PER_PAGE: 100,
  REFRESH_MS: 60000,
  FETCH_PAGE_SIZE: 1000,
  PRINT_NOTE: "",
};
