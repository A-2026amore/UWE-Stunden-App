import { render } from "preact";
import "../../design/styles";
import { applyBranding, initTheme, setAssetBase } from "../../design";
import { EmployeeApp } from "./App";
import { registerServiceWorker } from "./serviceWorker";

setAssetBase("../");
initTheme();
applyBranding(null);
render(<EmployeeApp />, document.getElementById("root")!);
registerServiceWorker();
