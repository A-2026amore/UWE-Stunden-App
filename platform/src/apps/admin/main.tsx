import { render } from "preact";
import "../../design/styles";
import { setAssetBase } from "../../design";
import { AdminApp } from "./App";

setAssetBase("../");
render(<AdminApp />, document.getElementById("root")!);
