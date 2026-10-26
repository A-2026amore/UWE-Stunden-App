import { render } from "preact";
import "../../design/styles";
import { setAssetBase } from "../../design";
import { EmployeeApp } from "./App";

setAssetBase("../");
render(<EmployeeApp />, document.getElementById("root")!);
