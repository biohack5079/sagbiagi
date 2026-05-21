import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// ページ遷移方式（location.href）を採用したため、
// DOM経由のイベントリスナー登録は不要になりました。
// これによりFirebase上のHPの動作に干渉せず、
// Cloudflare Pages側でクリーンにアプリが起動します。