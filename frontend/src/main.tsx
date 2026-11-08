import { render } from 'preact';
import './styles.css';
import { App } from './App';
import { startStore } from './store';
import { registerServiceWorker } from './push';

// Theme: saved choice, else system.
const saved = localStorage.getItem('theme');
document.documentElement.setAttribute('data-theme',
  saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

registerServiceWorker();
startStore();
render(<App />, document.getElementById('app')!);
