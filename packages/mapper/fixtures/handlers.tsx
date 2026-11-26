import { perform as renderCheckout } from "./linked.js";

function handleCheckout() {
  if (flagsmith.hasFeature("checkout")) return renderCheckout();
  return null;
}

function handler() {
  return handleCheckout();
}

router.post("/checkout", handler);
router.get("/search", () => req.flags["search"]?.enabled && fetch("/results"));
const selection = useFlags(["checkout", "search"]);
const other = helpers.configure("mode", "checkout");
const experiment = sdk.getExperimentFlag("search");
export const Dashboard = () => <main>{flags.search ? "New" : "Old"}</main>;
