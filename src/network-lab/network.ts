export type DeviceKind = "router" | "switch" | "pc" | "server" | "laptop" | "wireless-router" | "nas" | "cloud";
export type HostDeviceKind = "pc" | "server" | "laptop" | "nas" | "cloud";

export interface DhcpLease {
  address: string;
  mask: string;
  gateway: string;
  dnsServer: string;
  poolName: string;
}

export interface NatTranslation {
  protocol: "icmp";
  insideGlobal: string;
  insideLocal: string;
  outsideLocal: string;
  outsideGlobal: string;
}

export interface NetworkInterface {
  name: string;
  ip: string;
  mask: string;
  enabled: boolean;
  mode: "access" | "trunk";
  accessVlan: number;
  allowedVlans: number[];
}

export interface StaticRoute {
  network: string;
  mask: string;
  nextHop: string;
  exitInterface?: string;
}

export interface Vlan {
  id: number;
  name: string;
}

export interface OspfNetwork {
  network: string;
  wildcard: string;
  area: number;
}

export interface ConfiguredCommand {
  section: string;
  command: string;
}

export interface NetworkDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  hostname: string;
  x: number;
  y: number;
  interfaces: NetworkInterface[];
  gateway: string;
  dnsServer: string;
  vlans: Vlan[];
  routes: StaticRoute[];
  ospfProcess: number | null;
  ospfNetworks: OspfNetwork[];
  configuredCommands: ConfiguredCommand[];
  startupConfig: string | null;
  debugging: string[];
  dhcpLease: DhcpLease | null;
  natTranslations: NatTranslation[];
}

export interface NetworkCable {
  id: string;
  from: string;
  to: string;
  fromInterface: string;
  toInterface: string;
  medium?: "wired" | "wireless";
}

export interface NetworkState {
  devices: NetworkDevice[];
  cables: NetworkCable[];
}

export interface SubnetInfo {
  network: string;
  broadcast: string;
  firstHost: string;
  lastHost: string;
  mask: string;
  prefix: number;
  totalAddresses: number;
  usableHosts: number;
}

export interface PingResult {
  ok: boolean;
  message: string;
  path: string[];
  cableIds: string[];
}

const makeInterface = (name: string, ip = "", mask = ""): NetworkInterface => ({
  name,
  ip,
  mask,
  enabled: true,
  mode: "access",
  accessVlan: 1,
  allowedVlans: [1],
});

export function isHostDevice(kind: DeviceKind): kind is HostDeviceKind {
  return ["pc", "server", "laptop", "nas", "cloud"].includes(kind);
}

export function isRouterDevice(kind: DeviceKind): boolean {
  return kind === "router" || kind === "wireless-router";
}

export function hostInterface(state: NetworkState, device: NetworkDevice): NetworkInterface | undefined {
  const connectedWirelessly = state.cables.some(
    (cable) => cable.medium === "wireless" && (cable.from === device.id || cable.to === device.id),
  );
  return device.interfaces.find((networkInterface) =>
    connectedWirelessly ? networkInterface.name === "wlan0" : networkInterface.name !== "wlan0",
  ) ?? device.interfaces[0];
}

export function createStarterNetwork(): NetworkState {
  const router: NetworkDevice = {
    id: "router-1",
    kind: "router",
    name: "R1",
    hostname: "R1",
    x: 50,
    y: 34,
    interfaces: [
      makeInterface("G0/0", "192.168.10.1", "255.255.255.0"),
      makeInterface("G0/1", "192.168.20.1", "255.255.255.0"),
    ],
    gateway: "",
    dnsServer: "",
    vlans: [],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };
  const switchLeft: NetworkDevice = {
    id: "switch-1",
    kind: "switch",
    name: "SW1",
    hostname: "SW1",
    x: 23,
    y: 59,
    interfaces: Array.from({ length: 8 }, (_, i) => makeInterface(`Fa0/${i + 1}`)),
    gateway: "",
    dnsServer: "",
    vlans: [{ id: 1, name: "default" }],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };
  const switchRight: NetworkDevice = {
    id: "switch-2",
    kind: "switch",
    name: "SW2",
    hostname: "SW2",
    x: 77,
    y: 59,
    interfaces: Array.from({ length: 8 }, (_, i) => makeInterface(`Fa0/${i + 1}`)),
    gateway: "",
    dnsServer: "",
    vlans: [{ id: 1, name: "default" }],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };
  const pcLeft: NetworkDevice = {
    id: "pc-1",
    kind: "pc",
    name: "PC1",
    hostname: "PC1",
    x: 23,
    y: 84,
    interfaces: [makeInterface("eth0", "192.168.10.10", "255.255.255.0")],
    gateway: "192.168.10.1",
    dnsServer: "",
    vlans: [],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };
  const pcRight: NetworkDevice = {
    id: "pc-2",
    kind: "pc",
    name: "PC2",
    hostname: "PC2",
    x: 77,
    y: 84,
    interfaces: [makeInterface("eth0", "192.168.20.10", "255.255.255.0")],
    gateway: "192.168.20.1",
    dnsServer: "",
    vlans: [],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };

  return {
    devices: [router, switchLeft, switchRight, pcLeft, pcRight],
    cables: [
      { id: "cable-1", from: "router-1", to: "switch-1", fromInterface: "G0/0", toInterface: "Fa0/1" },
      { id: "cable-2", from: "router-1", to: "switch-2", fromInterface: "G0/1", toInterface: "Fa0/1" },
      { id: "cable-3", from: "pc-1", to: "switch-1", fromInterface: "eth0", toInterface: "Fa0/2" },
      { id: "cable-4", from: "pc-2", to: "switch-2", fromInterface: "eth0", toInterface: "Fa0/2" },
    ],
  };
}

export function createBlankNetwork(): NetworkState {
  return { devices: [], cables: [] };
}

export function createNetworkInterface(name: string): NetworkInterface {
  return makeInterface(name);
}

export function createDevice(kind: DeviceKind, index: number, positionIndex = index): NetworkDevice {
  const prefix = {
    router: "R",
    switch: "SW",
    pc: "PC",
    server: "SRV",
    laptop: "LAP",
    "wireless-router": "WRT",
    nas: "NAS",
    cloud: "CLOUD",
  }[kind];
  const interfaces =
    kind === "wireless-router"
      ? [makeInterface("G0/0"), ...Array.from({ length: 4 }, (_, i) => makeInterface(`Fa0/${i + 1}`)), makeInterface("wlan0")]
      : kind === "router"
        ? [makeInterface("G0/0"), makeInterface("G0/1")]
      : kind === "switch"
        ? Array.from({ length: 8 }, (_, i) => makeInterface(`Fa0/${i + 1}`))
        : kind === "laptop"
          ? [makeInterface("eth0"), makeInterface("wlan0")]
          : kind === "cloud"
            ? [makeInterface("G0/0", "203.0.113.1", "255.255.255.0"), makeInterface("G0/1")]
            : [makeInterface("eth0")];
  if (kind === "router" || kind === "wireless-router") interfaces.forEach((networkInterface) => (networkInterface.enabled = false));
  if (kind === "cloud") interfaces[0].enabled = true;
  const columns = [17, 39, 61, 83];

  return {
    id: `${kind}-${crypto.randomUUID()}`,
    kind,
    name: `${prefix}${index}`,
    hostname: `${prefix}${index}`,
    x: columns[(positionIndex - 1) % columns.length],
    y: 18 + (Math.floor((positionIndex - 1) / columns.length) % 3) * 26,
    interfaces,
    gateway: "",
    dnsServer: "",
    vlans: kind === "switch" ? [{ id: 1, name: "default" }] : [],
    routes: [],
    ospfProcess: null,
    ospfNetworks: [],
    configuredCommands: [],
    startupConfig: null,
    debugging: [],
    dhcpLease: null,
    natTranslations: [],
  };
}

export function isValidIPv4(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
  );
}

export function isValidSubnetMask(mask: string): boolean {
  if (!isValidIPv4(mask)) return false;
  const bits = mask
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("");
  return /^1*0*$/.test(bits);
}

export function sameSubnet(first: string, second: string, mask: string): boolean {
  if (!isValidIPv4(first) || !isValidIPv4(second) || !isValidSubnetMask(mask)) return false;
  const firstOctets = first.split(".").map(Number);
  const secondOctets = second.split(".").map(Number);
  const maskOctets = mask.split(".").map(Number);
  return firstOctets.every((octet, index) => (octet & maskOctets[index]) === (secondOctets[index] & maskOctets[index]));
}

function ipToNumber(value: string): number {
  return value.split(".").map(Number).reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function numberToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

export function subnetInfo(cidr: string): SubnetInfo | null {
  const [ip, rawPrefix, extra] = cidr.split("/");
  if (extra !== undefined || !isValidIPv4(ip) || !/^\d{1,2}$/.test(rawPrefix ?? "")) return null;
  const prefix = Number(rawPrefix);
  if (prefix < 0 || prefix > 32) return null;
  const maskNumber = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const addressNumber = ipToNumber(ip);
  const networkNumber = (addressNumber & maskNumber) >>> 0;
  const broadcastNumber = (networkNumber | (~maskNumber >>> 0)) >>> 0;
  const totalAddresses = 2 ** (32 - prefix);
  const pointToPoint = prefix >= 31;

  return {
    network: numberToIp(networkNumber),
    broadcast: numberToIp(broadcastNumber),
    firstHost: pointToPoint ? numberToIp(networkNumber) : numberToIp(networkNumber + 1),
    lastHost: pointToPoint ? numberToIp(broadcastNumber) : numberToIp(broadcastNumber - 1),
    mask: numberToIp(maskNumber),
    prefix,
    totalAddresses,
    usableHosts: pointToPoint ? totalAddresses : Math.max(0, totalAddresses - 2),
  };
}

export function prefixFromMask(mask: string): number | null {
  if (!isValidIPv4(mask)) return null;
  const bits = mask.split(".").map((octet) => Number(octet).toString(2).padStart(8, "0")).join("");
  return /^1*0*$/.test(bits) ? bits.indexOf("0") === -1 ? 32 : bits.indexOf("0") : null;
}

export function wildcardFromMask(mask: string): string {
  return numberToIp((~ipToNumber(mask)) >>> 0);
}

function networkMatches(ip: string, network: string, wildcard: string): boolean {
  if (!isValidIPv4(ip) || !isValidIPv4(network) || !isValidIPv4(wildcard)) return false;
  const mask = (~ipToNumber(wildcard)) >>> 0;
  return ((ipToNumber(ip) & mask) >>> 0) === ((ipToNumber(network) & mask) >>> 0);
}

function recordCloudNat(
  state: NetworkState,
  router: NetworkDevice,
  insideInterface: NetworkInterface,
  outsideInterface: NetworkInterface,
  sourceAddress: string,
  destinationAddress: string,
): string {
  const configured = router.configuredCommands;
  const globalCommands = configured.filter((entry) => entry.section === "" || entry.section === "global");
  const hasInside = configured.some(
    (entry) => entry.section === `interface ${insideInterface.name}` && entry.command.toLowerCase() === "ip nat inside",
  );
  const hasOutside = configured.some(
    (entry) => entry.section === `interface ${outsideInterface.name}` && entry.command.toLowerCase() === "ip nat outside",
  );
  if (!hasInside || !hasOutside) return "No NAT translation (inside/outside interfaces are not both configured).";

  const staticNat = globalCommands
    .map((entry) => entry.command.match(/^ip nat inside source static (\S+) (\S+)$/i))
    .find((match) => match?.[1] === sourceAddress);
  let insideGlobal = staticNat?.[2] ?? "";
  if (!insideGlobal) {
    const overload = globalCommands
      .map((entry) => entry.command.match(/^ip nat inside source list (\S+) interface (\S+) overload$/i))
      .find((match) => match?.[2].toLowerCase() === outsideInterface.name.toLowerCase());
    if (!overload) return "No NAT translation (no matching static or overload rule).";
    const matchingAcl = globalCommands
      .map((entry) => entry.command.match(/^access-list (\S+) permit (\S+)(?: (\S+))?$/i))
      .find((match) => match?.[1] === overload[1] && (
        match[2].toLowerCase() === "any" ||
        networkMatches(sourceAddress, match[2], match[3] ?? "")
      ));
    if (!matchingAcl) return "No NAT translation (the overload ACL did not permit this source).";
    insideGlobal = outsideInterface.ip;
  }
  if (!insideGlobal) return "No NAT translation (inside-global address is unavailable).";
  const exists = router.natTranslations.some((translation) =>
    translation.insideLocal === sourceAddress &&
    translation.outsideGlobal === destinationAddress &&
    translation.insideGlobal === insideGlobal,
  );
  if (!exists) {
    router.natTranslations.push({
      protocol: "icmp",
      insideGlobal,
      insideLocal: sourceAddress,
      outsideLocal: destinationAddress,
      outsideGlobal: destinationAddress,
    });
  }
  return `NAT translated ${sourceAddress} to ${insideGlobal}.`;
}

function getDevice(devices: NetworkDevice[], id: string): NetworkDevice | undefined {
  return devices.find((device) => device.id === id);
}

function interfaceIsUp(device: NetworkDevice | undefined, name: string): boolean {
  return device?.interfaces.find((networkInterface) => networkInterface.name === name)?.enabled === true;
}

function vlanPermits(device: NetworkDevice | undefined, name: string, vlanId: number): boolean {
  if (device?.kind !== "switch") return true;
  const networkInterface = device.interfaces.find((item) => item.name === name);
  if (!networkInterface) return false;
  if (networkInterface.mode === "access") return networkInterface.accessVlan === vlanId;
  return networkInterface.allowedVlans.includes(0) || networkInterface.allowedVlans.includes(vlanId);
}

export function hostVlan(state: NetworkState, hostId: string): number {
  const cable = state.cables.find((item) => item.from === hostId || item.to === hostId);
  if (!cable) return 1;
  const switchId = cable.from === hostId ? cable.to : cable.from;
  const switchInterfaceName = cable.from === switchId ? cable.fromInterface : cable.toInterface;
  const switchDevice = getDevice(state.devices, switchId);
  const switchInterface = switchDevice?.interfaces.find((item) => item.name === switchInterfaceName);
  return switchDevice?.kind === "switch" ? switchInterface?.accessVlan ?? 1 : 1;
}

export function findLanPath(
  state: NetworkState,
  startId: string,
  targetId: string,
  vlanId = 1,
): { deviceIds: string[]; cableIds: string[] } | null {
  const pending = [startId];
  const visited = new Set([startId]);
  const previous = new Map<string, { deviceId: string; cable: NetworkCable }>();

  while (pending.length > 0) {
    const currentId = pending.shift();
    if (!currentId) continue;
    if (currentId === targetId) break;
    const current = getDevice(state.devices, currentId);
    if (!current || (currentId !== startId && current.kind !== "switch" && current.kind !== "wireless-router")) continue;

    for (const cable of state.cables) {
      const neighborId = cable.from === currentId ? cable.to : cable.to === currentId ? cable.from : null;
      if (
        !neighborId ||
        visited.has(neighborId) ||
        !interfaceIsUp(getDevice(state.devices, cable.from), cable.fromInterface) ||
        !interfaceIsUp(getDevice(state.devices, cable.to), cable.toInterface) ||
        !vlanPermits(getDevice(state.devices, cable.from), cable.fromInterface, vlanId) ||
        !vlanPermits(getDevice(state.devices, cable.to), cable.toInterface, vlanId)
      ) {
        continue;
      }
      visited.add(neighborId);
      previous.set(neighborId, { deviceId: currentId, cable });
      pending.push(neighborId);
    }
  }

  if (!visited.has(targetId)) return null;
  const deviceIds = [targetId];
  const cableIds: string[] = [];
  let cursor = targetId;

  while (cursor !== startId) {
    const step = previous.get(cursor);
    if (!step) return null;
    cableIds.unshift(step.cable.id);
    deviceIds.unshift(step.deviceId);
    cursor = step.deviceId;
  }

  return { deviceIds, cableIds };
}

export function interfaceAtPathEnd(
  state: NetworkState,
  router: NetworkDevice,
  cableIds: string[],
  routerAtPathStart = false,
): NetworkInterface | undefined {
  const cableId = routerAtPathStart ? cableIds[0] : cableIds[cableIds.length - 1];
  const cable = state.cables.find((item) => item.id === cableId);
  if (!cable) return undefined;
  const interfaceName = cable.from === router.id ? cable.fromInterface : cable.toInterface;
  return router.interfaces.find((networkInterface) => networkInterface.name === interfaceName);
}

export function simulatePing(state: NetworkState, sourceId: string, destinationIp: string): PingResult {
  const source = getDevice(state.devices, sourceId);
  if (!source || !isHostDevice(source.kind)) {
    return { ok: false, message: "Choose an end device as the ping source.", path: [], cableIds: [] };
  }
  const sourceInterface = hostInterface(state, source);
  if (!sourceInterface?.enabled) {
    return { ok: false, message: `${source.name} interface is administratively down.`, path: [], cableIds: [] };
  }
  if (!isValidIPv4(sourceInterface.ip) || !isValidSubnetMask(sourceInterface.mask)) {
    return { ok: false, message: `${source.name} needs a valid IPv4 address and subnet mask.`, path: [], cableIds: [] };
  }
  if (!isValidIPv4(destinationIp)) {
    return { ok: false, message: `"${destinationIp}" is not a valid IPv4 address.`, path: [], cableIds: [] };
  }

  const destination = state.devices.find(
    (device) =>
      isHostDevice(device.kind) &&
      hostInterface(state, device)?.enabled &&
      hostInterface(state, device)?.ip === destinationIp,
  );
  if (!destination) {
    return { ok: false, message: `No reachable host is configured with ${destinationIp}.`, path: [], cableIds: [] };
  }
  if (destination.id === source.id) {
    return { ok: true, message: "Reply from your own interface.", path: [source.name], cableIds: [] };
  }

  const destinationInterface = hostInterface(state, destination);
  if (!destinationInterface || !isValidIPv4(destinationInterface.ip) || !isValidSubnetMask(destinationInterface.mask)) {
    return { ok: false, message: `${destination.name} needs a valid IPv4 address and subnet mask.`, path: [], cableIds: [] };
  }

  const sourceVlan = hostVlan(state, source.id);
  const destinationVlan = hostVlan(state, destination.id);
  const sourceLan = findLanPath(state, source.id, destination.id, sourceVlan);
  if (
    sourceLan &&
    sourceVlan === destinationVlan &&
    sameSubnet(sourceInterface.ip, destinationIp, sourceInterface.mask) &&
    sameSubnet(destinationInterface.ip, sourceInterface.ip, destinationInterface.mask)
  ) {
    return {
      ok: true,
      message: `Reply from ${destinationIp}: same LAN, ${sourceLan.cableIds.length} link(s).`,
      path: sourceLan.deviceIds.map((id) => getDevice(state.devices, id)?.name ?? id),
      cableIds: sourceLan.cableIds,
    };
  }

  const routers = state.devices.filter((device) => isRouterDevice(device.kind));
  for (const router of routers) {
    const sourceLanPath = findLanPath(state, source.id, router.id, sourceVlan);
    if (!sourceLanPath) continue;

    const sourceRouterInterface = interfaceAtPathEnd(state, router, sourceLanPath.cableIds);
    if (
      !sourceRouterInterface?.enabled ||
      !isValidIPv4(sourceRouterInterface.ip) ||
      !isValidSubnetMask(sourceRouterInterface.mask) ||
      !sameSubnet(sourceInterface.ip, sourceRouterInterface.ip, sourceInterface.mask) ||
      source.gateway !== sourceRouterInterface.ip ||
      !sameSubnet(sourceRouterInterface.ip, sourceInterface.ip, sourceRouterInterface.mask)
    ) {
      continue;
    }

    for (const destinationRouter of routers) {
      const destinationLanPath = findLanPath(state, destinationRouter.id, destination.id, destinationVlan);
      if (!destinationLanPath) continue;
      const destinationRouterInterface = interfaceAtPathEnd(
        state,
        destinationRouter,
        destinationLanPath.cableIds,
        true,
      );
      if (
        !destinationRouterInterface?.enabled ||
        !isValidIPv4(destinationRouterInterface.ip) ||
        !isValidSubnetMask(destinationRouterInterface.mask) ||
        !sameSubnet(destinationInterface.ip, destinationRouterInterface.ip, destinationInterface.mask) ||
        destination.gateway !== destinationRouterInterface.ip ||
        !sameSubnet(destinationRouterInterface.ip, destinationInterface.ip, destinationRouterInterface.mask)
      ) {
        continue;
      }

      if (router.id === destinationRouter.id) {
        return {
          ok: true,
          message: `Reply from ${destinationIp}: routed by ${router.name} across ${sourceLanPath.cableIds.length + destinationLanPath.cableIds.length} link(s).`,
          path: [...sourceLanPath.deviceIds, ...destinationLanPath.deviceIds.slice(1)].map(
            (id) => getDevice(state.devices, id)?.name ?? id,
          ),
          cableIds: [...sourceLanPath.cableIds, ...destinationLanPath.cableIds],
        };
      }

      const candidateVlans = new Set(
        state.devices
          .filter((device) => device.kind === "switch")
          .flatMap((device) =>
            device.interfaces.flatMap((networkInterface) =>
              networkInterface.mode === "access"
                ? [networkInterface.accessVlan]
                : networkInterface.allowedVlans,
            ),
          ),
      );
      candidateVlans.add(1);
      let transitPath: { deviceIds: string[]; cableIds: string[]; vlanId: number } | null = null;
      for (const vlanId of candidateVlans) {
        const candidatePath = findLanPath(state, router.id, destinationRouter.id, vlanId);
        if (candidatePath) {
          transitPath = { ...candidatePath, vlanId };
          break;
        }
      }
      if (!transitPath) continue;

      const sourceTransitInterface = interfaceAtPathEnd(state, router, transitPath.cableIds, true);
      const destinationTransitInterface = interfaceAtPathEnd(
        state,
        destinationRouter,
        transitPath.cableIds,
      );
      if (
        !sourceTransitInterface?.enabled ||
        !destinationTransitInterface?.enabled ||
        !isValidIPv4(sourceTransitInterface.ip) ||
        !isValidIPv4(destinationTransitInterface.ip) ||
        !isValidSubnetMask(sourceTransitInterface.mask) ||
        !sameSubnet(sourceTransitInterface.ip, destinationTransitInterface.ip, sourceTransitInterface.mask)
      ) {
        continue;
      }

      const sourceHasStaticRoute = router.routes.some(
        (route) =>
          sameSubnet(destinationIp, route.network, route.mask) &&
          (route.nextHop === destinationTransitInterface.ip || route.exitInterface === sourceTransitInterface.name),
      );
      const destinationHasStaticRoute = destinationRouter.routes.some(
        (route) =>
          sameSubnet(sourceInterface.ip, route.network, route.mask) &&
          (route.nextHop === sourceTransitInterface.ip || route.exitInterface === destinationTransitInterface.name),
      );
      const sourceOspfArea = router.ospfNetworks.find(
        (network) =>
          networkMatches(sourceTransitInterface.ip, network.network, network.wildcard) &&
          networkMatches(destinationTransitInterface.ip, network.network, network.wildcard),
      )?.area;
      const destinationOspfArea = destinationRouter.ospfNetworks.find(
        (network) =>
          networkMatches(sourceTransitInterface.ip, network.network, network.wildcard) &&
          networkMatches(destinationTransitInterface.ip, network.network, network.wildcard),
      )?.area;
      const ospfAdjacency =
        router.ospfProcess !== null &&
        destinationRouter.ospfProcess !== null &&
        sourceOspfArea !== undefined &&
        sourceOspfArea === destinationOspfArea &&
        destinationRouter.ospfNetworks.some((network) =>
          networkMatches(destinationRouterInterface.ip, network.network, network.wildcard),
        ) &&
        router.ospfNetworks.some((network) =>
          networkMatches(sourceRouterInterface.ip, network.network, network.wildcard),
        );
      const staticRouting = sourceHasStaticRoute && destinationHasStaticRoute;
      if (!staticRouting && !ospfAdjacency) continue;

      return {
        ok: true,
        message: `Reply from ${destinationIp}: ${staticRouting ? "static routes" : `OSPF area ${sourceOspfArea}`} via ${router.name} → ${destinationRouter.name}.`,
        path: [
          ...sourceLanPath.deviceIds,
          ...transitPath.deviceIds.slice(1),
          ...destinationLanPath.deviceIds.slice(1),
        ].map((id) => getDevice(state.devices, id)?.name ?? id),
        cableIds: [...sourceLanPath.cableIds, ...transitPath.cableIds, ...destinationLanPath.cableIds],
      };
    }
  }

  if (destination.kind === "cloud") {
    for (const router of routers) {
      const sourceLanPath = findLanPath(state, source.id, router.id, sourceVlan);
      if (!sourceLanPath) continue;
      const sourceRouterInterface = interfaceAtPathEnd(state, router, sourceLanPath.cableIds);
      if (
        !sourceRouterInterface?.enabled ||
        !isValidIPv4(sourceRouterInterface.ip) ||
        !isValidSubnetMask(sourceRouterInterface.mask) ||
        source.gateway !== sourceRouterInterface.ip ||
        !sameSubnet(sourceInterface.ip, sourceRouterInterface.ip, sourceInterface.mask)
      ) continue;

      const cloudPath = findLanPath(state, router.id, destination.id, 1);
      if (!cloudPath) continue;
      const wanInterface = interfaceAtPathEnd(state, router, cloudPath.cableIds, true);
      const cloudInterface = interfaceAtPathEnd(state, destination, cloudPath.cableIds);
      if (
        !wanInterface?.enabled ||
        !cloudInterface?.enabled ||
        !isValidIPv4(wanInterface.ip) ||
        !isValidSubnetMask(wanInterface.mask) ||
        cloudInterface.ip !== destinationIp
      ) continue;
      const connectedRoute = sameSubnet(wanInterface.ip, destinationIp, wanInterface.mask);
      const configuredRoute = router.routes.some((route) =>
        sameSubnet(destinationIp, route.network, route.mask) &&
        (route.nextHop === cloudInterface.ip || route.exitInterface === wanInterface.name),
      );
      if (!connectedRoute && !configuredRoute) continue;
      const natStatus = recordCloudNat(state, router, sourceRouterInterface, wanInterface, sourceInterface.ip, destinationIp);
      return {
        ok: true,
        message: `Reply from ${destinationIp}: simulated cloud reached via ${router.name}. ${natStatus}`,
        path: [...sourceLanPath.deviceIds, ...cloudPath.deviceIds.slice(1)].map(
          (id) => getDevice(state.devices, id)?.name ?? id,
        ),
        cableIds: [...sourceLanPath.cableIds, ...cloudPath.cableIds],
      };
    }
  }

  const sourceRouter = routers.find((router) => findLanPath(state, source.id, router.id));
  if (!sourceRouter) {
    return { ok: false, message: "No physical path to a router. Check cables and interface status.", path: [], cableIds: [] };
  }
  const routerInterface = interfaceAtPathEnd(state, sourceRouter, findLanPath(state, source.id, sourceRouter.id)?.cableIds ?? []);
  if (source.gateway !== routerInterface?.ip) {
    return {
      ok: false,
      message: `Destination is outside the local subnet. Set ${source.name}'s default gateway to its router interface.`,
      path: [],
      cableIds: [],
    };
  }
  return {
    ok: false,
    message: "No matching connected route. Check the router's interface IPs, host gateways, subnet masks, and links.",
    path: [],
    cableIds: [],
  };
}
