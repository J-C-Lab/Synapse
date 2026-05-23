import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import "./i18n"
import "./globals.css"

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root not found in index.html")

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
