import { render } from "preact";
import "../../design/styles";
import { setAssetBase } from "../../design";
import { ChefApp } from "./App";

setAssetBase("../");
render(<ChefApp />, document.getElementById("root")!);
