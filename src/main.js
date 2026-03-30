import { App } from "./App.js";

const { React, ReactDOM } = window;

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
);
