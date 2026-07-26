// Populates the total-count badges next to sidebar menu items. Called on
// boot and after mutations (create/delete) so the badge stays fresh without
// forcing a full page reload.

import { countCompanies } from '../entities/companies.mjs';
import { countPeople } from '../entities/people.mjs';
import { countApplications } from '../entities/applications.mjs';

const setCount = (key, n) => {
  const el = document.querySelector(`[data-sidebar-count="${key}"]`);
  if (!el) return;
  if (n > 0) {
    el.textContent = String(n);
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
};

export const refreshSidebarCounts = async () => {
  const [companies, people, apps] = await Promise.all([
    countCompanies(),
    countPeople(),
    countApplications(),
  ]);
  setCount('companies', companies);
  setCount('people', people);
  setCount('applications', apps);
};
