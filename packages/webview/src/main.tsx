import { render } from 'preact';
import { App } from './App.js';
import './styles.css';
import 'uplot/dist/uPlot.min.css';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
