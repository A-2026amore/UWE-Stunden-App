import { render } from "preact";
import "../../design/styles";
import { setAssetBase } from "../../design";
import { EmployeeApp } from "./App";
import { registerServiceWorker } from "./serviceWorker";

setAssetBase("../");
render(<EmployeeApp />, document.getElementById("root")!);
registerServiceWorker();
