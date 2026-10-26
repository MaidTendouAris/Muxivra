import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'
if(new URLSearchParams(window.location.search).get('window')==='source-editor'){
  void import('./source-editor/SourceEditor').then(({default:SourceEditor})=>ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><SourceEditor /></React.StrictMode>))
}else{
  void import('./App').then(({App})=>ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>))
}
