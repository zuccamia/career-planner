package applications

// Types exported to the RPC layer. The browser owns application persistence.

// Statuses lists the supported application workflow states in display order.
// Exposed via /api/db/enums.json so the browser renders matching dropdowns.
var Statuses = []string{"wishlist", "applied", "online_assessment", "first_interview", "second_interview", "additional_interview", "offer", "rejected", "withdrawn"}
