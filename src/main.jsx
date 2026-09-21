// @pdf-lib/fontkit is an older babel build: its complex-script shapers
// (Bengali, Devanagari, Arabic ...) are compiled to generators and need
// this global, or shaping throws and the text silently loses its font.
import 'regenerator-runtime/runtime.js'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
