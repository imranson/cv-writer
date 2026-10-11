import './styles.css';
import { refreshJobs, refreshSessions, restoreLastSession } from './actions.ts';
import { api } from './api.ts';
import { ChatView } from './chat.ts';
import { h, mount, toast } from './dom.ts';
import { Sidebar } from './sidebar.ts';
import { bus, state } from './state.ts';
import { Workspace } from './workspace.ts';

async function main() {
  const root = document.getElementById('app')!;
  const sidebar = new Sidebar();
  const chat = new ChatView();
  const workspace = new Workspace();
  mount(root, h('div', { class: 'layout' }, sidebar.el, chat.el, workspace.el));

  try {
    state.info = await api.config();
    sidebar.renderFooter();
  } catch {
    toast('Could not reach the server.', 'error');
  }
  await Promise.all([refreshJobs(), refreshSessions()]);
  await restoreLastSession();
  chat.render();
  await workspace.init();

  // Keep job scores in the sidebar fresh when agents change things.
  bus.on('artifact', ({ kind }) => {
    if (kind === 'cv' || kind === 'critique' || kind === 'job') void refreshJobs();
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.running) e.preventDefault();
  });
}

void main();
