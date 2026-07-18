import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Apply the saved theme before first paint to avoid a light-mode flash.
document.documentElement.dataset.theme =
  localStorage.getItem("aura-theme") === "dark" ? "dark" : "light";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
