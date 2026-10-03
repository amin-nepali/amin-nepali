<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  createDevice,
  createBlankNetwork,
  createStarterNetwork,
  hostInterface,
  isHostDevice,
  simulatePing,
  type DeviceKind,
  type NetworkCable,
  type NetworkDevice,
  type NetworkInterface,
  type NetworkState,
  type PingResult,
} from "./network";
import { executeNetworkCommand, type CliContext } from "./commands";

type LabTab = "device" | "terminal" | "guide";
type TerminalLine = { type: "command" | "output" | "error"; text: string };

const state = ref<NetworkState>(createBlankNetwork());
const selectedDeviceId = ref("");
const selectedDevice = computed(
  () => state.value.devices.find((device) => device.id === selectedDeviceId.value) ?? null,
);
const activeTab = ref<LabTab>("device");
const connectMode = ref(false);
const connectSourceId = ref<string | null>(null);
const statusMessage = ref("Blank lab · add devices, configure them in the CLI, then connect them.");
const statusType = ref<"info" | "success" | "error">("info");
const sourceId = ref("");
const destinationIp = ref("");
const pingResult = ref<PingResult | null>(null);
const animatedCables = ref<string[]>([]);
const terminalLines = ref<TerminalLine[]>([
  { type: "output", text: "NetLab IOS simulator · type help to see available commands." },
]);
const terminalCommand = ref("");
const terminalElement = ref<HTMLElement | null>(null);
const cliInterfaceName = ref("");
const cliContext = ref<CliContext>({ mode: "user" });
const isDragging = ref(false);
const canvas = ref<HTMLElement | null>(null);
const isWindowsDesktop = ref(false);
const isOnline = ref(navigator.onLine);
const isInstalled = ref(window.matchMedia("(display-mode: standalone)").matches);
const installAvailable = ref(false);
const localSaveReady = ref(false);
const storageMessage = ref("");
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};
let installPromptEvent: InstallPromptEvent | null = null;
let dragDeviceId: string | null = null;
let dragPointerId: number | null = null;
let dragStart = { x: 0, y: 0 };
let dragMoved = false;
let pingTimer: number | undefined;

const hosts = computed(() => state.value.devices.filter((device) => isHostDevice(device.kind) && device.kind !== "cloud"));
const links = computed(() =>
  state.value.cables.map((cable) => ({
    cable,
    from: state.value.devices.find((device) => device.id === cable.from),
    to: state.value.devices.find((device) => device.id === cable.to),
  })).filter((link): link is { cable: NetworkCable; from: NetworkDevice; to: NetworkDevice } => Boolean(link.from && link.to)),
);
const nodeColor: Record<DeviceKind, string> = {
  router: "#c3f76a",
  switch: "#6dd5ed",
  pc: "#a99bff",
  server: "#f0b96b",
  laptop: "#8fd8c8",
  "wireless-router": "#c3f76a",
  nas: "#ef9bb5",
  cloud: "#82b8ff",
};
const deviceLabels: Record<DeviceKind, string> = {
  router: "Router",
  switch: "Switch",
  pc: "PC",
  server: "Server",
  laptop: "Laptop",
  "wireless-router": "Wi-Fi Router",
  nas: "NAS",
  cloud: "Cloud",
};
const deviceSymbols: Record<DeviceKind, string> = {
  router: "◇",
  switch: "▦",
  pc: "▣",
  server: "▤",
  laptop: "▱",
  "wireless-router": "⌁",
  nas: "▥",
  cloud: "☁",
};
const deviceKinds: DeviceKind[] = [
  "router", "switch", "pc", "laptop", "server", "wireless-router", "nas", "cloud",
];

const terminalPrompt = computed(() => {
  const name = selectedDevice.value?.hostname ?? "device";
  const modePrompt: Partial<Record<CliContext["mode"], string>> = {
    global: "config",
    interface: "config-if",
    vlan: "config-vlan",
    "router-ospf": "config-router",
    "router-ospfv3": "config-router",
    "router-eigrp": "config-router",
    "router-bgp": "config-router",
    "address-family": "config-router-af",
    "af-interface": "config-router-af-interface",
    line: "config-line",
    "dhcp-pool": "dhcp-config",
    "ip-sla": "config-ip-sla",
    "acl-standard": "config-std-nacl",
    "acl-extended": "config-ext-nacl",
  };
  if (modePrompt[cliContext.value.mode]) return `${name}(${modePrompt[cliContext.value.mode]})#`;
  return `${name}${cliContext.value.mode === "privileged" ? "#" : ">"}`;
});

const STORAGE_KEY = "amin-network-lab-state-v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNetworkState(value: unknown): value is NetworkState {
  return isRecord(value)
    && Array.isArray(value.devices)
    && Array.isArray(value.cables)
    && value.devices.every((device) =>
      isRecord(device)
      && typeof device.id === "string"
      && typeof device.kind === "string"
      && typeof device.name === "string"
      && typeof device.hostname === "string"
      && typeof device.x === "number"
      && typeof device.y === "number"
      && Array.isArray(device.interfaces)
      && typeof device.gateway === "string"
      && typeof device.dnsServer === "string"
      && Array.isArray(device.vlans)
      && Array.isArray(device.routes)
      && Array.isArray(device.ospfNetworks)
      && Array.isArray(device.configuredCommands)
      && Array.isArray(device.debugging)
      && Array.isArray(device.natTranslations)
      && (device.dhcpLease === null || isRecord(device.dhcpLease)),
    )
    && value.cables.every((cable) =>
      isRecord(cable)
      && typeof cable.id === "string"
      && typeof cable.from === "string"
      && typeof cable.to === "string"
      && typeof cable.fromInterface === "string"
      && typeof cable.toInterface === "string",
    );
}

function restoreLocalState() {
  try {
    const rawState = localStorage.getItem(STORAGE_KEY);
    if (!rawState) {
      localSaveReady.value = true;
      return;
    }
    const saved: unknown = JSON.parse(rawState);
    if (
      !isRecord(saved)
      || saved.version !== 1
      || !isNetworkState(saved.network)
      || typeof saved.selectedDeviceId !== "string"
    ) {
      throw new Error("Saved lab data has an unsupported or invalid format.");
    }
    state.value = saved.network;
    selectedDeviceId.value = state.value.devices.some((device) => device.id === saved.selectedDeviceId)
      ? saved.selectedDeviceId
      : state.value.devices[0]?.id ?? "";
    sourceId.value = state.value.devices.find((device) => isHostDevice(device.kind) && device.kind !== "cloud")?.id ?? "";
    localSaveReady.value = true;
    storageMessage.value = "Saved topology restored from this PC.";
    setStatus(storageMessage.value, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown local-storage error.";
    storageMessage.value = `Could not restore saved topology: ${message}`;
    localSaveReady.value = true;
    setStatus(storageMessage.value, "error");
  }
}

function saveLocalState() {
  if (!localSaveReady.value || !isWindowsDesktop.value) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      network: state.value,
      selectedDeviceId: selectedDeviceId.value,
    }));
    storageMessage.value = "Saved on this PC.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown local-storage error.";
    storageMessage.value = `Could not save topology locally: ${message}`;
    setStatus(storageMessage.value, "error");
  }
}

async function installAsApp() {
  if (!installPromptEvent) {
    setStatus("In Microsoft Edge or Chrome, use the browser menu → Apps → Install this site as an app.", "info");
    return;
  }
  try {
    await installPromptEvent.prompt();
    const result = await installPromptEvent.userChoice;
    if (result.outcome === "accepted") setStatus("Network Lab installed as a Windows app.", "success");
    installPromptEvent = null;
    installAvailable.value = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown install prompt error.";
    setStatus(`Could not open the app install prompt: ${message}`, "error");
  }
}

async function registerOfflineSupport() {
  if (!("serviceWorker" in navigator)) {
    setStatus("This Windows browser does not support offline app storage.", "error");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("/network-lab-sw.js", { scope: "/" });
    const readyRegistration = await navigator.serviceWorker.ready;
    const worker = readyRegistration.active ?? registration.active;
    const cachedResources = performance.getEntriesByType("resource")
      .map((entry) => new URL(entry.name))
      .filter((url) => url.origin === location.origin && (
        url.pathname.startsWith("/assets/") ||
        url.pathname === "/network-lab.html" ||
        url.pathname === "/network-lab.webmanifest" ||
        url.pathname === "/network-lab-icon-192.png" ||
        url.pathname === "/network-lab-icon-512.png" ||
        url.pathname === "/network-lab-icon.svg"
      ))
      .map((url) => url.href);
    if (!worker) throw new Error("No active service worker is available.");
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error("Timed out while saving offline resources."));
      }, 10000);
      channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; message?: string }>) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        if (event.data.ok) resolve();
        else reject(new Error(event.data.message || "The service worker could not cache app resources."));
      };
      worker.postMessage(
        { type: "CACHE_APP_RESOURCES", urls: [...new Set(cachedResources)] },
        [channel.port2],
      );
    });
    setStatus("Offline app ready · resources are cached on this PC.", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown service-worker error.";
    setStatus(`Offline support could not be enabled: ${message}`, "error");
  }
}

function onBeforeInstallPrompt(event: Event) {
  event.preventDefault();
  installPromptEvent = event as InstallPromptEvent;
  installAvailable.value = true;
}

function onAppInstalled() {
  isInstalled.value = true;
  installAvailable.value = false;
  installPromptEvent = null;
}

function onOnline() {
  isOnline.value = true;
}

function onOffline() {
  isOnline.value = false;
}

onMounted(() => {
  isWindowsDesktop.value =
    /^win/i.test(navigator.platform) &&
    !window.matchMedia("(pointer: coarse)").matches &&
    window.innerWidth >= 1024;
  if (!isWindowsDesktop.value) return;
  restoreLocalState();
  void registerOfflineSupport();
  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
});

function edgeMidpoint(cable: NetworkCable): { x: number; y: number } {
  const from = state.value.devices.find((device) => device.id === cable.from);
  const to = state.value.devices.find((device) => device.id === cable.to);
  return {
    x: (((from?.x ?? 0) + (to?.x ?? 0)) / 2) * 10,
    y: (((from?.y ?? 0) + (to?.y ?? 0)) / 2) * 7,
  };
}

function setStatus(message: string, type: "info" | "success" | "error" = "info") {
  statusMessage.value = message;
  statusType.value = type;
}

function countKind(kind: DeviceKind): number {
  const prefix = {
    router: "R", switch: "SW", pc: "PC", server: "SRV", laptop: "LAP",
    "wireless-router": "WRT", nas: "NAS", cloud: "CLOUD",
  }[kind];
  let index = 1;
  while (state.value.devices.some((device) => device.name === `${prefix}${index}`)) index += 1;
  return index;
}

function deviceAddress(device: NetworkDevice): string {
  return hostInterface(state.value, device)?.ip
    || device.interfaces.find((networkInterface) => networkInterface.ip)?.ip
    || deviceLabels[device.kind].toUpperCase();
}

function addDevice(kind: DeviceKind) {
  const device = createDevice(kind, countKind(kind), state.value.devices.length + 1);
  state.value.devices.push(device);
  selectedDeviceId.value = device.id;
  if (isHostDevice(kind) && !sourceId.value) sourceId.value = device.id;
  activeTab.value = "device";
  connectMode.value = false;
  setStatus(`${device.name} added · configure it with the terminal and connect a port.`, "success");
}

function openConnectionMode() {
  connectMode.value = !connectMode.value;
  connectSourceId.value = null;
  setStatus(
    connectMode.value ? "Connect mode · select the first device, then the second." : "Connect mode cancelled.",
  );
}

function nextFreeInterface(device: NetworkDevice): NetworkInterface | undefined {
  return device.interfaces.find(
    (networkInterface) =>
      !state.value.cables.some(
        (cable) =>
          (cable.from === device.id && cable.fromInterface === networkInterface.name) ||
          (cable.to === device.id && cable.toInterface === networkInterface.name),
      ),
  );
}

function selectCanvasDevice(device: NetworkDevice) {
  selectedDeviceId.value = device.id;
  if (!connectMode.value) {
    activeTab.value = "device";
    return;
  }

  if (!connectSourceId.value) {
    connectSourceId.value = device.id;
    setStatus(`${device.name} selected · choose the other device to make a link.`);
    return;
  }
  if (connectSourceId.value === device.id) {
    connectSourceId.value = null;
    setStatus("Choose a different device for the other end of the link.");
    return;
  }

  const first = state.value.devices.find((item) => item.id === connectSourceId.value);
  const firstPort = first ? nextFreeInterface(first) : undefined;
  const secondPort = nextFreeInterface(device);
  if (!first || !firstPort || !secondPort) {
    setStatus("No free Ethernet interface on one of those devices. Add another device or use a free port.", "error");
    connectSourceId.value = null;
    return;
  }
  if (
    state.value.cables.some(
      (cable) =>
        (cable.from === first.id && cable.to === device.id) ||
        (cable.from === device.id && cable.to === first.id),
    )
  ) {
    setStatus("Those devices already have a direct cable.", "error");
    connectSourceId.value = null;
    return;
  }

  state.value.cables.push({
    id: `cable-${crypto.randomUUID()}`,
    from: first.id,
    to: device.id,
    fromInterface: firstPort.name,
    toInterface: secondPort.name,
  });
  connectMode.value = false;
  connectSourceId.value = null;
  setStatus(`Cable connected · ${first.name} ${firstPort.name} ↔ ${device.name} ${secondPort.name}.`, "success");
}

function startDragging(event: PointerEvent, device: NetworkDevice) {
  if (event.button !== 0 || connectMode.value) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  target.setPointerCapture(event.pointerId);
  dragDeviceId = device.id;
  dragPointerId = event.pointerId;
  dragStart = { x: event.clientX, y: event.clientY };
  dragMoved = false;
  isDragging.value = true;
  selectedDeviceId.value = device.id;
}

function moveDevice(event: PointerEvent, device: NetworkDevice) {
  if (!isDragging.value || dragDeviceId !== device.id || dragPointerId !== event.pointerId || !canvas.value) return;
  const rect = canvas.value.getBoundingClientRect();
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
  if (!dragMoved) return;
  device.x = Math.min(92, Math.max(8, ((event.clientX - rect.left) / rect.width) * 100));
  device.y = Math.min(91, Math.max(10, ((event.clientY - rect.top) / rect.height) * 100));
  dragStart = { x: event.clientX, y: event.clientY };
}

function stopDragging(event: PointerEvent, device: NetworkDevice) {
  if (dragDeviceId !== device.id || dragPointerId !== event.pointerId) return;
  if (event.currentTarget instanceof HTMLElement && event.currentTarget.hasPointerCapture(event.pointerId)) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  if (dragMoved) setStatus(`${device.name} moved · topology saved for this session.`);
  dragDeviceId = null;
  dragPointerId = null;
  isDragging.value = false;
  window.setTimeout(() => {
    dragMoved = false;
  }, 0);
}

function resetLab() {
  state.value = createBlankNetwork();
  selectedDeviceId.value = "";
  sourceId.value = "";
  destinationIp.value = "";
  cliContext.value = { mode: "user" };
  cliInterfaceName.value = "";
  connectMode.value = false;
  connectSourceId.value = null;
  pingResult.value = null;
  animatedCables.value = [];
  terminalLines.value = [{ type: "output", text: "NetLab IOS simulator · type help to see available commands." }];
  setStatus("Blank lab · add devices, configure them in the CLI, then connect them.");
}

function loadSample() {
  state.value = createStarterNetwork();
  selectedDeviceId.value = "router-1";
  sourceId.value = "pc-1";
  destinationIp.value = "192.168.20.10";
  connectMode.value = false;
  connectSourceId.value = null;
  pingResult.value = null;
  animatedCables.value = [];
  terminalLines.value = [{ type: "output", text: "NetLab IOS simulator · type help to see available commands." }];
  cliContext.value = { mode: "user" };
  setStatus("Optional sample loaded · inspect its configuration and routing.", "success");
}

function clearLab() {
  resetLab();
}

function removeSelectedDevice() {
  const deviceId = selectedDeviceId.value;
  const device = state.value.devices.find((item) => item.id === deviceId);
  if (!device) return;
  state.value.cables = state.value.cables.filter((cable) => cable.from !== deviceId && cable.to !== deviceId);
  state.value.devices = state.value.devices.filter((item) => item.id !== deviceId);
  selectedDeviceId.value = state.value.devices[0]?.id ?? "";
  if (sourceId.value === deviceId) sourceId.value = hosts.value[0]?.id ?? "";
  pingResult.value = null;
  setStatus(`${device.name} removed from the workspace.`);
}

function runPing() {
  if (!sourceId.value) {
    const message = "Add a PC or server and configure it before running a ping.";
    pingResult.value = { ok: false, message, path: [], cableIds: [] };
    setStatus(message, "error");
    return;
  }
  const result = simulatePing(state.value, sourceId.value, destinationIp.value.trim());
  pingResult.value = result;
  animatedCables.value = result.ok ? result.cableIds : [];
  setStatus(result.message, result.ok ? "success" : "error");
  if (pingTimer !== undefined) window.clearTimeout(pingTimer);
  if (result.ok) pingTimer = window.setTimeout(() => (animatedCables.value = []), 1800);
}

function executeCommand(rawCommand: string) {
  const command = rawCommand.trim();
  if (!command) return;
  const device = selectedDevice.value;
  terminalLines.value.push({ type: "command", text: `${terminalPrompt.value} ${command}` });
  if (!device) {
    terminalLines.value.push({ type: "error", text: "Select a device before running commands." });
    return;
  }

  if (command.toLowerCase() === "clear") {
    terminalLines.value = [];
    return;
  }

  const result = executeNetworkCommand(state.value, device, command, cliContext.value, cliInterfaceName.value);
  cliContext.value = result.context;
  cliInterfaceName.value = result.interfaceName;
  terminalLines.value.push({ type: result.error ? "error" : "output", text: result.output });
  if (result.ping) {
    pingResult.value = result.ping;
    animatedCables.value = result.ping.ok ? result.ping.cableIds : [];
    setStatus(result.ping.message, result.ping.ok ? "success" : "error");
    if (pingTimer !== undefined) window.clearTimeout(pingTimer);
    if (result.ping.ok) pingTimer = window.setTimeout(() => (animatedCables.value = []), 1800);
  }
  nextTick(() => {
    if (terminalElement.value) terminalElement.value.scrollTop = terminalElement.value.scrollHeight;
  });
}

function submitCommand() {
  executeCommand(terminalCommand.value);
  terminalCommand.value = "";
}

watch(selectedDeviceId, () => {
  const device = selectedDevice.value;
  cliInterfaceName.value = device?.interfaces[0]?.name ?? "";
  cliContext.value = { mode: "user" };
});

watch(state, saveLocalState, { deep: true });
watch(selectedDeviceId, saveLocalState);

watch(hosts, (currentHosts) => {
  if (!currentHosts.some((host) => host.id === sourceId.value)) {
    sourceId.value = currentHosts[0]?.id ?? "";
  }
}, { deep: true });

onBeforeUnmount(() => {
  if (pingTimer !== undefined) window.clearTimeout(pingTimer);
  window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.removeEventListener("appinstalled", onAppInstalled);
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
});
</script>

<template>
  <div class="netlab">
    <section v-if="!isWindowsDesktop" class="platform-gate" role="dialog" aria-modal="true">
      <span class="brand-mark" aria-hidden="true">A</span>
      <p class="eyebrow">WINDOWS DESKTOP APP</p>
      <h1>Network Lab is for Windows PCs.</h1>
      <p>Open this page in Microsoft Edge or Chrome on a Windows desktop or laptop. Mobile devices and other operating systems are not supported.</p>
    </section>
    <header class="lab-header">
      <a class="lab-brand" href="/" aria-label="Return to Amin Nepali's portfolio">
        <span class="brand-mark">A</span>
        <span class="brand-name">amin<span>nepali</span><small>NETWORK LAB</small></span>
      </a>
      <div class="header-status" :class="{ offline: !isOnline }">
        <i></i>{{ isOnline ? "SIMULATION MODE" : "OFFLINE MODE" }}
        <span class="save-indicator">{{ storageMessage || "LOCAL AUTO-SAVE" }}</span>
      </div>
      <div class="header-actions">
        <button class="install-button" type="button" @click="installAsApp">{{ isInstalled ? "Installed" : installAvailable ? "Install app" : "Install" }}</button>
        <a class="back-link" href="/">Portfolio <span aria-hidden="true">↗</span></a>
      </div>
    </header>

    <main class="lab-main">
      <section class="lab-board" aria-label="Networking practice lab">
        <div class="board-topbar">
          <div class="board-title"><span class="live-indicator"></span><div><strong>Network Lab</strong><small>{{ state.devices.length }} devices · {{ state.cables.length }} links</small></div></div>
          <div class="board-actions">
            <button class="secondary-button" type="button" @click="clearLab">Clear</button>
            <button class="secondary-button" type="button" @click="loadSample"><span aria-hidden="true">◇</span> Load example</button>
          </div>
        </div>

        <div class="lab-grid">
          <section class="workspace">
            <div class="device-toolbar" aria-label="Add network device">
              <details class="device-picker">
                <summary><span aria-hidden="true">＋</span> Add device</summary>
                <div class="device-menu">
                  <button v-for="kind in deviceKinds" :key="kind" class="device-add" type="button" @click="addDevice(kind)">
                    <span class="mini-device" :class="`kind-${kind}`" aria-hidden="true">{{ deviceSymbols[kind] }}</span>
                    <span>{{ deviceLabels[kind] }}</span>
                  </button>
                </div>
              </details>
              <span class="toolbar-hint">Select a node to inspect · use Connect to link free ports</span>
              <button class="connect-button" :class="{ active: connectMode }" type="button" @click="openConnectionMode">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 6-1.2-1.2a3 3 0 0 0-4.2 4.2l3.2 3.2a3 3 0 0 0 4.2 0l1.4-1.4m2.6-4.8 1.2-1.2a3 3 0 0 1 4.2 4.2l-3.2 3.2a3 3 0 0 1-4.2 0l-1.4-1.4m-2.4 3.6 6-6" /></svg>
                {{ connectMode ? "Cancel" : "Connect" }}
              </button>
            </div>

            <div class="canvas-scroll">
              <div ref="canvas" class="topology-canvas" :class="{ 'connect-mode': connectMode }" @click.self="connectMode && (connectSourceId = null)">
                <div class="canvas-grid" aria-hidden="true"></div>
                <div class="canvas-label canvas-label-top">LOGICAL TOPOLOGY <span>· {{ state.devices.length }} DEVICES</span></div>
                <div class="canvas-hint" :class="{ 'hint-visible': connectMode }">
                  {{ connectSourceId ? "Now select the destination device" : "Select two devices to connect them" }}
                </div>
                <svg class="cable-layer" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-label="Network connections">
                  <defs>
                    <filter id="cable-glow" x="-100%" y="-100%" width="300%" height="300%">
                      <feGaussianBlur stdDeviation="4" result="blur" />
                      <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                    </filter>
                  </defs>
                  <g v-for="{ cable, from, to } in links" :key="cable.id">
                    <line
                      :x1="from.x * 10" :y1="from.y * 7" :x2="to.x * 10" :y2="to.y * 7"
                      :class="{ 'cable-active': animatedCables.includes(cable.id), 'cable-wireless': cable.medium === 'wireless' }"
                      :style="{ '--cable-color': nodeColor[from.kind] }"
                    />
                    <circle v-if="animatedCables.includes(cable.id)" :cx="edgeMidpoint(cable).x" :cy="edgeMidpoint(cable).y" r="8" class="packet-dot" filter="url(#cable-glow)" />
                  </g>
                </svg>

                <button
                  v-for="device in state.devices"
                  :key="device.id"
                  class="device-node"
                  :class="[`node-${device.kind}`, { selected: selectedDeviceId === device.id, 'connection-source': connectSourceId === device.id, dragging: isDragging && selectedDeviceId === device.id }]"
                  :style="{ left: `${device.x}%`, top: `${device.y}%`, '--device-accent': nodeColor[device.kind] }"
                  type="button"
                  :aria-label="`${device.name}, ${device.kind}, ${deviceAddress(device)}`"
                  @pointerdown.stop="startDragging($event, device)"
                  @pointermove="moveDevice($event, device)"
                  @pointerup="stopDragging($event, device)"
                  @pointercancel="stopDragging($event, device)"
                  @click.stop="selectCanvasDevice(device)"
                >
                  <span class="node-icon" aria-hidden="true">
                    <svg v-if="device.kind === 'router'" viewBox="0 0 36 36"><path d="M18 4 31 11v14l-13 7-13-7V11L18 4Z"/><path d="M10 18h16m-4-4 4 4-4 4M26 18H10m4-4-4 4 4 4"/></svg>
                    <svg v-else-if="device.kind === 'wireless-router'" viewBox="0 0 36 36"><rect x="5" y="19" width="26" height="11" rx="3"/><path d="M11 24h2m5 0h2m5 0h2M12 15a9 9 0 0 1 12 0m-9-4a5 5 0 0 1 6 0"/></svg>
                    <svg v-else-if="device.kind === 'switch'" viewBox="0 0 36 36"><rect x="4" y="8" width="28" height="20" rx="4"/><path d="M10 14h3m4 0h3m4 0h3m-17 8h3m4 0h3m4 0h3"/></svg>
                    <svg v-else-if="device.kind === 'server'" viewBox="0 0 36 36"><rect x="7" y="5" width="22" height="26" rx="4"/><path d="M12 12h9m-9 7h9m-9 7h9"/><circle cx="25" cy="12" r="1"/><circle cx="25" cy="19" r="1"/><circle cx="25" cy="26" r="1"/></svg>
                    <svg v-else-if="device.kind === 'nas'" viewBox="0 0 36 36"><rect x="6" y="7" width="24" height="22" rx="4"/><path d="M11 13h14m-14 6h14m-14 6h8"/><circle cx="25" cy="25" r="1"/></svg>
                    <svg v-else-if="device.kind === 'cloud'" viewBox="0 0 36 36"><path d="M10 27h17a6 6 0 0 0 .3-12A9 9 0 0 0 10 13a7 7 0 0 0 0 14Z"/></svg>
                    <svg v-else-if="device.kind === 'laptop'" viewBox="0 0 36 36"><rect x="8" y="6" width="20" height="20" rx="2"/><path d="M4 30h28l-3-4H7l-3 4Z"/></svg>
                    <svg v-else viewBox="0 0 36 36"><rect x="5" y="6" width="26" height="19" rx="3"/><path d="M13 31h10m-5-6v6m-7-16 4 4-4 4m7 0h6"/></svg>
                  </span>
                  <span class="node-details"><strong>{{ device.name }}</strong><small>{{ deviceAddress(device) }}</small></span>
                  <span class="node-port" :class="{ 'port-up': device.interfaces.some(i => i.enabled) }"></span>
                </button>

                <div v-if="state.devices.length === 0" class="empty-canvas">
                  <span>◇</span><strong>Build your own topology</strong><small>Add devices above, connect ports, then configure them from the CLI.</small>
                  <button type="button" @click="loadSample">Load an optional example</button>
                </div>

                <div class="canvas-legend"><span><i class="legend-up"></i> Link up</span><span><i class="legend-down"></i> No signal</span></div>
              </div>
            </div>

            <div class="workspace-status" :class="`status-${statusType}`">
              <span class="status-symbol">{{ statusType === "success" ? "✓" : statusType === "error" ? "!" : "i" }}</span>
              <span>{{ statusMessage }}</span>
            </div>

            <section class="ping-panel" aria-label="Ping test">
              <div class="ping-heading"><span class="ping-icon">↗</span><div><strong>Connectivity test</strong><small>Simulate an ICMP echo request</small></div></div>
              <div class="ping-controls">
                <label>FROM
                  <select v-model="sourceId">
                    <option v-for="host in hosts" :key="host.id" :value="host.id">{{ host.name }} · {{ hostInterface(state, host)?.ip || "no IP" }}</option>
                  </select>
                </label>
                <span class="ping-arrow" aria-hidden="true">→</span>
                <label>DESTINATION IP
                  <input v-model="destinationIp" type="text" inputmode="decimal" spellcheck="false" placeholder="192.168.20.10" @keydown.enter="runPing">
                </label>
                <button class="ping-button" type="button" :disabled="hosts.length === 0 || !destinationIp" @click="runPing">Run ping <span aria-hidden="true">↗</span></button>
              </div>
              <small v-if="hosts.length === 0" class="ping-empty-note">Add and configure an end device to test connectivity.</small>
              <div v-if="pingResult" class="ping-output" :class="{ 'ping-success': pingResult.ok, 'ping-error': !pingResult.ok }">
                <span>{{ pingResult.ok ? "SUCCESS" : "FAILED" }}</span><code>{{ pingResult.message }}</code>
                <div v-if="pingResult.path.length" class="route-path"><b>PATH</b><span v-for="(hop, index) in pingResult.path" :key="`${hop}-${index}`">{{ index ? " → " : "" }}{{ hop }}</span></div>
              </div>
            </section>
          </section>

          <aside class="inspector">
            <div class="inspector-tabs" role="tablist" aria-label="Lab side panel">
              <button v-for="tab in (['device', 'terminal', 'guide'] as const)" :key="tab" :class="{ active: activeTab === tab }" type="button" role="tab" :aria-selected="activeTab === tab" @click="activeTab = tab">
                {{ { device: 'Device', terminal: 'CLI', guide: 'Guide' }[tab] }}
              </button>
            </div>

            <template v-if="activeTab === 'device'">
              <div v-if="selectedDevice" class="device-inspector">
                <div class="inspector-heading"><span class="inspector-device-icon" :style="{ color: nodeColor[selectedDevice.kind] }">{{ deviceSymbols[selectedDevice.kind] }}</span><div><small>SELECTED DEVICE</small><strong>{{ selectedDevice.name }}</strong></div><span class="kind-pill">{{ deviceLabels[selectedDevice.kind] }}</span></div>
                <p class="inspector-note">Device settings are read-only here. Use the CLI tab to configure addresses, VLANs, and interface state.</p>
                <details v-for="networkInterface in selectedDevice.interfaces" :key="networkInterface.name" class="interface-details">
                  <summary class="interface-summary">
                    <strong>{{ networkInterface.name }}</strong>
                    <span>{{ networkInterface.ip || (selectedDevice.kind === 'switch' ? `VLAN ${networkInterface.accessVlan} · ${networkInterface.mode}` : "unassigned") }}</span>
                    <i :class="{ enabled: networkInterface.enabled }"></i>
                  </summary>
                  <div class="interface-card">
                  <div class="interface-title"><strong>{{ networkInterface.name }}</strong><span class="interface-state" :class="{ enabled: networkInterface.enabled }">{{ networkInterface.enabled ? "UP" : "DOWN" }}</span></div>
                  <template v-if="selectedDevice.kind !== 'switch'">
                    <div class="interface-value"><span>IP ADDRESS</span><code>{{ networkInterface.ip || "unassigned" }}</code></div>
                    <div class="interface-value"><span>SUBNET MASK</span><code>{{ networkInterface.mask || "unassigned" }}</code></div>
                  </template>
                  <template v-else>
                    <div class="interface-value"><span>SWITCHPORT MODE</span><code>{{ networkInterface.mode }}</code></div>
                    <div class="interface-value"><span>ACCESS VLAN</span><code>{{ networkInterface.accessVlan }}</code></div>
                    <div v-if="networkInterface.mode === 'trunk'" class="interface-value"><span>ALLOWED VLANs</span><code>{{ networkInterface.allowedVlans.includes(0) ? "all" : networkInterface.allowedVlans.join(", ") || "none" }}</code></div>
                  </template>
                  <div class="interface-live"><i :class="{ down: !networkInterface.enabled }"></i>{{ state.cables.some(c => (c.from === selectedDevice?.id && c.fromInterface === networkInterface.name) || (c.to === selectedDevice?.id && c.toInterface === networkInterface.name)) ? (networkInterface.enabled ? "Connected" : "Cable present · interface down") : "Not connected" }}</div>
                  </div>
                </details>
                <div v-if="isHostDevice(selectedDevice.kind)" class="interface-value gateway-value"><span>DEFAULT GATEWAY</span><code>{{ selectedDevice.gateway || "not set" }}</code></div>
                <div class="config-actions">
                  <button type="button" class="configure-terminal" @click="activeTab = 'terminal'">Configure in CLI <span>↗</span></button>
                  <button type="button" class="danger-button" @click="removeSelectedDevice">Remove device</button>
                </div>
              </div>
              <div v-else class="no-selection"><span>◇</span><strong>Select a device</strong><small>Choose a node on the topology to configure it.</small></div>
            </template>

            <section v-else-if="activeTab === 'terminal'" class="terminal-panel">
              <div class="terminal-top"><span><i></i><i></i><i></i></span><label>IOS-LIKE CLI</label><select v-model="selectedDeviceId" aria-label="Terminal device"><option v-for="device in state.devices" :key="device.id" :value="device.id">{{ device.name }}</option></select></div>
              <div ref="terminalElement" class="terminal-output" aria-live="polite">
                <div v-for="(line, index) in terminalLines" :key="index" class="terminal-line" :class="`line-${line.type}`"><span v-for="(row, rowIndex) in line.text.split('\n')" :key="rowIndex">{{ row }}</span></div>
              </div>
              <form class="terminal-form" @submit.prevent="submitCommand"><span>{{ terminalPrompt }}</span><input v-model="terminalCommand" aria-label="CLI command" autocomplete="off" spellcheck="false" :placeholder="selectedDevice ? 'type a command' : 'add a device to begin'"><button type="submit" aria-label="Run command" :disabled="!selectedDevice">↵</button></form>
              <div class="terminal-help">Try <button type="button" @click="executeCommand('help')">help</button><span>·</span><button type="button" @click="executeCommand('show ip interface brief')">show ip interface brief</button><span>·</span><button type="button" @click="executeCommand('subnet 192.168.10.1/24')">subnet 192.168.10.1/24</button></div>
            </section>

            <section v-else class="guide-panel">
              <p class="guide-kicker">START HERE</p>
              <h2>Make the first packet travel.</h2>
              <p class="guide-copy">Build a topology from scratch. Configure devices with IOS-style commands; test the result using simulated packets.</p>
              <ol class="guide-steps">
                <li><span>01</span><div><strong>Add devices &amp; connect ports</strong><small>Use Connect and select two nodes to cable them.</small></div></li>
                <li><span>02</span><div><strong>Configure device interfaces</strong><small>enable → conf t → interface G0/0 → ip address &lt;IP&gt; &lt;MASK&gt; → no shutdown.</small></div></li>
                <li><span>03</span><div><strong>Set up switching</strong><small>vlan 10 → name USERS → exit → interface Fa0/1 → switchport mode access → switchport access vlan 10. Use exit before choosing another port.</small></div></li>
                <li><span>04</span><div><strong>Route &amp; test</strong><small>Set host IPs with ipconfig IP MASK GATEWAY; configure static routes or OSPF, then ping.</small></div></li>
              </ol>
              <details class="guide-callout"><summary>ADD-ON COMPONENTS</summary><p>DHCP: configure <code>ip dhcp pool USERS</code>, <code>network</code>, and <code>default-router</code> on a router; clients run <code>ipconfig /renew</code>. Wi-Fi: configure the wireless router SSID/password, bring up <code>wlan0</code>, then connect a laptop with <code>wireless connect SSID password PASS</code>. NAS: use <code>share create public</code>, then <code>share write public notes.txt hello</code>; clients use <code>nas list|read|write NAS-IP public</code>. DNS records are added on a server with <code>dns record NAME IP</code>. For NAT, mark router interfaces <code>ip nat inside/outside</code>, add a permitting ACL and PAT rule, route to the cloud, then ping and inspect <code>show ip nat translations</code>.</p></details>
              <details class="guide-callout"><summary>SIMULATION SCOPE</summary><p>This is an educational simulator, not Cisco IOS or Packet Tracer. Ping, IPv4 routing, DHCP leases and relay, DNS records, Wi-Fi associations, NAS file shares, VLAN paths, basic single-area OSPF, and NAT translation tracking affect simulated behavior. The cloud uses documentation-only IP addresses and never connects to the real Internet. ACL enforcement, IPv6 packet routing, EIGRP, BGP, OSPFv3, HSRP, and hardware STP remain configuration-only.</p></details>
              <button class="guide-command" type="button" @click="activeTab = 'terminal'; executeCommand('help')">Open supported command list <span>↗</span></button>
            </section>
          </aside>
        </div>

        <footer class="board-footer"><span><i></i> All traffic is simulated locally in your browser</span><span>NETLAB <b>·</b> CCNA FUNDAMENTALS</span></footer>
      </section>

    </main>
  </div>
</template>
