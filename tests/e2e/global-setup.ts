import { resetTestServer } from '../../playwright.config';

async function globalSetup() {
  await resetTestServer();
}

export default globalSetup;