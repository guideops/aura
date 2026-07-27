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

// Registering a service worker is what makes the shell installable as a PWA
// (and gives it an offline fallback). Dev builds skip it so Vite's HMR isn't
// shadowed by a cached shell.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/shell/sw.js", { scope: "/shell/" });
  });
}
