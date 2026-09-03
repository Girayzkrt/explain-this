import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import {
  getOriginGuidance,
  type OriginGuidancePlatform,
} from "../../features/onboarding/origin-guidance";
import { OnboardingClient } from "../../platform/messaging/onboarding-client";
import { readerBrowserApi } from "../../platform/permissions/browser-api";
import { ReaderAccessController } from "../../platform/permissions/reader-access";
import { createSettingsRepository } from "../../platform/storage/settings-repository";
import { getExtensionStorageAreas } from "../../platform/storage/storage-area";
import { OptionsApp, type OptionsAppDependencies } from "./OptionsApp";
import "./options.css";

function currentPlatform(): OriginGuidancePlatform {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "macos";
  if (platform.includes("linux")) return "linux";
  return "unknown";
}

const storage = getExtensionStorageAreas();
const dependencies: OptionsAppDependencies = {
  createClient: () => new OnboardingClient(browser.runtime),
  settingsRepository: createSettingsRepository(storage.local, () =>
    browser.i18n.getUILanguage(),
  ),
  readerAccess: new ReaderAccessController(readerBrowserApi),
  getUiLanguage: () => browser.i18n.getUILanguage(),
  getOriginGuidance: () => getOriginGuidance(currentPlatform(), browser.runtime.id),
  getDiagnosticFacts: () => ({
    extensionVersion: browser.runtime.getManifest().version,
    platform: navigator.platform,
    endpoint: { hostname: "127.0.0.1" },
  }),
  copyDiagnosticReport: (report) => navigator.clipboard.writeText(report),
};

const root = document.getElementById("root");
if (!root) throw new Error("Options root is unavailable.");

createRoot(root).render(
  <StrictMode>
    <OptionsApp dependencies={dependencies} />
  </StrictMode>,
);
