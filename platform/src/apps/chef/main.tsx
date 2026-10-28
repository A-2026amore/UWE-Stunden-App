import { render } from "preact";
import "../../design/styles";
import { applyBranding, initTheme, setAssetBase } from "../../design";
import { ChefApp } from "./App";

setAssetBase("../");
initTheme();
applyBranding(null);
render(<ChefApp />, document.getElementById("root")!);
