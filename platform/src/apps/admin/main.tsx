import { render } from "preact";
import "../../design/styles";
import { applyBranding, initTheme, setAssetBase } from "../../design";
import { AdminApp } from "./App";

setAssetBase("../");
initTheme();
applyBranding(null);
render(<AdminApp />, document.getElementById("root")!);
