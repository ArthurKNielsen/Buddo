import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles/base.css';
import './styles/app.css';
import './styles/buddy.css';
import './styles/skins.css';
import './styles/landing.css';

createRoot(document.getElementById('root')).render(<App />);
