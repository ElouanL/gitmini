import './styles/index.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { app } from './lib/stores/app.svelte';
import { bootstrap } from './lib/bootstrap';
// The order counts: the foundation registers its actions before the domains, which can replace them.
import './lib/register-core';
import './lib/register-domains';

// System theme applied immediately (no flash); `theme` replaces it from `settings_get`.
app.applyTheme();

const target = document.getElementById('app');
if (!target) throw new Error('#app introuvable');
mount(App, { target });

void bootstrap();
