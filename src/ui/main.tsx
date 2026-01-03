import React from 'react';
import ReactDOM from 'react-dom/client';
import AppShell from './pages/AppShell';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppShell />
  </React.StrictMode>,
);
