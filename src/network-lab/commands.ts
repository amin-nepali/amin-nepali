import {
  isValidIPv4,
  isValidSubnetMask,
  prefixFromMask,
  createNetworkInterface,
  findLanPath,
  hostInterface,
  hostVlan,
  interfaceAtPathEnd,
  isHostDevice,
  isRouterDevice,
  sameSubnet,
  simulatePing,
  subnetInfo,
  type NetworkDevice,
  type NetworkInterface,
  type NetworkState,
  type OspfNetwork,
  type PingResult,
  type StaticRoute,
} from "./network";

export type CliMode =
  | "user"
  | "privileged"
  | "global"
  | "interface"
  | "vlan"
  | "router-ospf"
  | "router-ospfv3"
  | "router-eigrp"
  | "router-bgp"
  | "address-family"
  | "af-interface"
  | "line"
  | "dhcp-pool"
  | "ip-sla"
  | "acl-standard"
  | "acl-extended";

export interface CliContext {
  mode: CliMode;
  vlanId?: number;
  target?: string;
  parent?: CliContext;
}

export interface CommandResult {
  output: string;
  error: boolean;
  context: CliContext;
  interfaceName: string;
  ping?: PingResult;
}

const helpText = [
  "MODES: enable; configure terminal (conf t); interface (int) NAME; interface range Fa0/1 - 4; vlan ID; router ospf|ospfv3|eigrp|bgp ID; exit; end",
  "DEVICE: hostname NAME; banner motd #TEXT#; enable secret PASSWORD; service password-encryption; username USER privilege 15 secret PASSWORD",
  "SECURITY: line console 0 | line vty 0 15; password; login; login local; transport input ssh|telnet|all; ip domain-name DOMAIN; ip ssh version 2; crypto key generate rsa general-keys modulus 2048",
  "SWITCH: interface vlan ID; switchport mode access|trunk; switchport access vlan ID; switchport trunk native vlan ID; switchport trunk allowed vlan LIST|all|add LIST|remove LIST",
  "SWITCH EXTRAS: switchport port-security [maximum N|violation protect|restrict|shutdown|mac-address sticky]; channel-group N mode active|passive|desirable|auto|on; interface port-channel N",
  "STP: spanning-tree mode pvst|rapid-pvst|mst; spanning-tree vlan ID root primary|secondary|priority N; spanning-tree portfast default; spanning-tree portfast bpduguard default; interface options portfast|bpduguard enable",
  "INTERFACES: description TEXT; ip address IP MASK; ipv6 address ADDRESS/PREFIX; encapsulation dot1Q VLAN; ip helper-address IP; ip nat inside|outside; standby GROUP ip IP|priority N|preempt",
  "ROUTES: ip route NETWORK MASK NEXT-HOP|INTERFACE; ipv6 route ::/0 NEXT-HOP|INTERFACE; router ospf ID; router-id IP; network IP WILDCARD area ID; passive-interface NAME",
  "PROTOCOL CONFIG: router ospfv3 ID; address-family ipv6 unicast; ospfv3 ID ipv6 area ID; router eigrp AS|NAME; network IP WILDCARD; no auto-summary; router bgp AS; neighbor IP remote-as AS; address-family ipv4 unicast",
  "IP SERVICES: ip dhcp excluded-address LOW HIGH; ip dhcp pool NAME; network IP MASK; default-router IP; dns-server IP; domain-name NAME; ip sla ID; icmp-echo IP source-interface INT; frequency SEC; track ID ip sla ID reachability",
  "NAT/ACL: ip nat inside source static LOCAL GLOBAL; access-list 1 permit|deny SOURCE WILDCARD; access-list 100 permit|deny tcp SOURCE WILDCARD DEST WILDCARD eq PORT; ip access-list standard|extended NAME; ip access-group ACL in|out",
  "INSPECT: show running-config|startup-config|version; show interfaces; show ip|ipv6 interface brief; show controllers; show vlan brief; show interfaces trunk; show mac address-table; show spanning-tree; show etherchannel summary",
  "MORE SHOW: show ip|ipv6 route; show ip dhcp binding; show ip nat translations; show standby brief; show ip ospf neighbor|interface; show ip eigrp neighbors; show ip bgp summary; show cdp|lldp neighbors [detail]",
  "TEST: ping IP; traceroute IP; debug ip icmp; debug ip ospf events; undebug all; no debug all; subnet IP/PREFIX; write memory; copy run start; erase startup-config; reload",
  "END DEVICES: ipconfig [IP MASK [GATEWAY [DNS]]]|/renew|/release; ip default-gateway IP; ping IP; traceroute IP; nslookup NAME.",
  "WIRELESS: wireless ssid NAME; wireless password PASS (wireless router); wireless connect SSID password PASS (laptop).",
  "NAS/DNS: share create|list|read|write (NAS); nas list|read|write IP SHARE [FILE [CONTENT]]; dns record NAME IP (server).",
  "EXECUTABLE SIMULATION: IPv4 ping/routing, DHCP leases and relay, DNS A-record lookups, Wi-Fi associations, NAS file shares, VLAN paths, static routing, basic single-area OSPF, and NAT translation tracking to the simulated cloud. Cloud uses documentation-only IP ranges, never the external Internet. EIGRP/BGP/OSPFv3, ACL enforcement, HSRP, and hardware STP remain configuration-only.",
].join("\n");

const modeLabels: Partial<Record<CliMode, string>> = {
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

function invalid(output: string, context: CliContext, interfaceName: string): CommandResult {
  return { output, error: true, context, interfaceName };
}

function success(output: string, context: CliContext, interfaceName: string): CommandResult {
  return { output, error: false, context, interfaceName };
}

function rememberCommand(device: NetworkDevice, section: string, command: string): void {
  const canonical = command.trim().replace(/\s+/g, " ");
  if (!canonical) return;
  const exists = device.configuredCommands.some(
    (entry) => entry.section === section && entry.command.toLowerCase() === canonical.toLowerCase(),
  );
  if (!exists) device.configuredCommands.push({ section, command: canonical });
}

function removeConfiguredCommand(device: NetworkDevice, section: string, prefix: string): boolean {
  const before = device.configuredCommands.length;
  const normalized = prefix.trim().replace(/\s+/g, " ").toLowerCase();
  device.configuredCommands = device.configuredCommands.filter(
    (entry) => entry.section !== section || !entry.command.toLowerCase().startsWith(normalized),
  );
  return before !== device.configuredCommands.length;
}

function featureConfig(device: NetworkDevice): string {
  const sections = new Map<string, string[]>();
  for (const entry of device.configuredCommands) {
    const lines = sections.get(entry.section) ?? [];
    lines.push(entry.command);
    sections.set(entry.section, lines);
  }
  return [...sections.entries()]
    .map(([section, lines]) => {
      if (section.toLowerCase().startsWith("interface ")) return "";
      const commands = lines.filter((line) => line.toLowerCase() !== section.toLowerCase());
      const header = section === "global" ? "" : section;
      return [header, ...commands.map((line) => header ? ` ${line}` : line)].filter(Boolean).join("\n");
    })
    .join("\n");
}

function validIPv6Address(value: string): boolean {
  if (!value || value.includes(":::") || (value.match(/::/g)?.length ?? 0) > 1) return false;
  const halves = value.split("::");
  const groups = halves.flatMap((half) => (half ? half.split(":") : []));
  if (groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function validIPv6Prefix(value: string): boolean {
  const [address, prefixLength, ...extra] = value.split("/");
  const length = Number(prefixLength);
  return extra.length === 0
    && validIPv6Address(address ?? "")
    && /^\d{1,3}$/.test(prefixLength ?? "")
    && length >= 0
    && length <= 128;
}

function renderRunningConfig(device: NetworkDevice): string {
  const interfaceConfig = device.interfaces.map((networkInterface) => {
    const lines = [`interface ${networkInterface.name}`];
    if (networkInterface.ip) lines.push(` ip address ${networkInterface.ip} ${networkInterface.mask}`);
    if (device.kind === "switch" && !/^vlan\d+$/i.test(networkInterface.name)) {
      lines.push(` switchport mode ${networkInterface.mode}`);
      if (networkInterface.mode === "access") lines.push(` switchport access vlan ${networkInterface.accessVlan}`);
      else lines.push(` switchport trunk allowed vlan ${networkInterface.allowedVlans.includes(0) ? "all" : networkInterface.allowedVlans.join(",")}`);
    }
    const features = device.configuredCommands.filter((entry) => entry.section === `interface ${networkInterface.name}`);
    features.forEach((entry) => lines.push(` ${entry.command}`));
    lines.push(networkInterface.enabled ? " no shutdown" : " shutdown");
    return lines.join("\n");
  });
  const vlans = device.vlans.map((vlan) => `vlan ${vlan.id}\n name ${vlan.name}`);
  const routes = device.routes.map((route) => `ip route ${route.network} ${route.mask} ${route.nextHop || route.exitInterface}`);
  const ospf = device.ospfProcess === null ? [] : [
    `router ospf ${device.ospfProcess}`,
    ...device.ospfNetworks.map((network) => ` network ${network.network} ${network.wildcard} area ${network.area}`),
  ];
  const hostGateway = isHostDevice(device.kind)
    ? [
      ...(device.gateway ? [`ip default-gateway ${device.gateway}`] : []),
      ...(device.dnsServer ? [`ip name-server ${device.dnsServer}`] : []),
    ]
    : [];
  return [`hostname ${device.hostname}`, ...interfaceConfig, ...vlans, ...routes, ...ospf, ...hostGateway, featureConfig(device)]
    .filter(Boolean)
    .join("\n");
}

function validFeatureCommand(mode: CliMode, words: string[]): boolean {
  const command = words.join(" ").toLowerCase();
  if (mode === "interface") {
    return /^(description .+|ipv6 address \S+|encapsulation dot1q \d+|ip helper-address \d{1,3}(?:\.\d{1,3}){3}|ip nat (inside|outside)|ip access-group \S+ (in|out)|access-class \S+ (in|out)|switchport trunk native vlan \d+|switchport port-security(?: .+)?|switchport port-security (maximum \d+|violation (protect|restrict|shutdown)|mac-address sticky)|channel-group \d+ mode (active|passive|desirable|auto|on)|standby \d+ (ip \d{1,3}(?:\.\d{1,3}){3}|priority \d+|preempt)|ospfv3 \d+ ipv6 area \d+|spanning-tree (portfast|bpduguard enable))$/.test(command);
  }
  if (mode === "global") {
    return /^(banner motd .+|enable secret \S+|service password-encryption|username \S+ privilege \d+ secret \S+|ip domain-name \S+|crypto key generate rsa general-keys modulus \d+|ip ssh version [12]|spanning-tree mode (pvst|rapid-pvst|mst)|spanning-tree vlan \d+ (root (primary|secondary)|priority \d+)|spanning-tree portfast default|spanning-tree portfast bpduguard default|ip dhcp excluded-address \d{1,3}(?:\.\d{1,3}){3} \d{1,3}(?:\.\d{1,3}){3}|ip dhcp pool \S+|ip nat inside source static \d{1,3}(?:\.\d{1,3}){3} \d{1,3}(?:\.\d{1,3}){3}|ip nat inside source list \S+ interface \S+ overload|access-list \d+ .+|ip access-list (standard|extended) \S+|ip sla \d+|ip sla schedule \d+ life forever start-time now|track \d+ ip sla \d+ reachability|ipv6 route \S+ \S+|no auto-summary)$/.test(command);
  }
  if (mode === "line") return /^(password \S+|login|login local|transport input (ssh|telnet|all)|access-class \S+ in)$/.test(command);
  if (mode === "dhcp-pool") return /^(network \d{1,3}(?:\.\d{1,3}){3} \d{1,3}(?:\.\d{1,3}){3}|default-router \d{1,3}(?:\.\d{1,3}){3}|dns-server \d{1,3}(?:\.\d{1,3}){3}|domain-name \S+)$/.test(command);
  if (mode === "ip-sla") return /^(icmp-echo \d{1,3}(?:\.\d{1,3}){3} source-interface \S+|frequency \d+)$/.test(command);
  if (mode === "router-ospf") return /^(router-id \d{1,3}(?:\.\d{1,3}){3}|passive-interface \S+|auto-cost reference-bandwidth \d+)$/.test(command);
  if (mode === "router-ospfv3") return command === "address-family ipv6 unicast";
  if (mode === "router-eigrp") return /^(network \d{1,3}(?:\.\d{1,3}){3} \d{1,3}(?:\.\d{1,3}){3}|passive-interface \S+|no auto-summary|address-family ipv4 autonomous-system \d+)$/.test(command);
  if (mode === "router-bgp") return /^(neighbor \d{1,3}(?:\.\d{1,3}){3} remote-as \d+|address-family ipv4 unicast|neighbor \d{1,3}(?:\.\d{1,3}){3} activate|network \d{1,3}(?:\.\d{1,3}){3} mask \d{1,3}(?:\.\d{1,3}){3})$/.test(command);
  if (mode === "address-family") return /^(network \d{1,3}(?:\.\d{1,3}){3} (?:\d{1,3}(?:\.\d{1,3}){3}|mask \d{1,3}(?:\.\d{1,3}){3})|neighbor \d{1,3}(?:\.\d{1,3}){3} activate|af-interface \S+)$/.test(command);
  if (mode === "af-interface") return command === "passive-interface";
  if (mode === "acl-standard") return /^(permit|deny) (host \d{1,3}(?:\.\d{1,3}){3}|\d{1,3}(?:\.\d{1,3}){3}(?: \d{1,3}(?:\.\d{1,3}){3})?)$/.test(command);
  if (mode === "acl-extended") return /^(permit|deny) tcp host \d{1,3}(?:\.\d{1,3}){3} host \d{1,3}(?:\.\d{1,3}){3} eq \S+$/.test(command);
  return false;
}

function ipv4ToNumber(ip: string): number {
  return ip.split(".").map(Number).reduce((total, octet) => ((total << 8) | octet) >>> 0, 0);
}

function normalizeInterfaceName(name: string): string {
  return name.toLowerCase()
    .replace(/^gigabitethernet|^gig|^gi/, "g")
    .replace(/^fastethernet|^fast|^fa/, "fa")
    .replace(/^ethernet|^eth/, "eth")
    .replace(/^port-channel|^portchannel|^po/, "po")
    .replace(/^vlan/, "vlan");
}

function networkMatches(ip: string, network: string, wildcard: string): boolean {
  if (!isValidIPv4(ip) || !isValidIPv4(network) || !isValidIPv4(wildcard)) return false;
  const inverseMask = (~ipv4ToNumber(wildcard)) >>> 0;
  return ((ipv4ToNumber(ip) & inverseMask) >>> 0) === ((ipv4ToNumber(network) & inverseMask) >>> 0);
}

function isConfiguredVlan(device: NetworkDevice, vlanId: number): boolean {
  return vlanId === 1 || device.vlans.some((vlan) => vlan.id === vlanId);
}

function parseVlans(raw: string): number[] | null {
  if (raw.toLowerCase() === "all") return [0];
  const values: number[] = [];
  for (const entry of raw.split(",")) {
    const range = entry.trim().split("-");
    if (range.length === 1 && /^\d+$/.test(range[0])) {
      values.push(Number(range[0]));
    } else if (
      range.length === 2 &&
      /^\d+$/.test(range[0]) &&
      /^\d+$/.test(range[1]) &&
      Number(range[0]) <= Number(range[1])
    ) {
      for (let vlanId = Number(range[0]); vlanId <= Number(range[1]); vlanId += 1) values.push(vlanId);
    } else {
      return null;
    }
  }
  return [...new Set(values)];
}

function routeTable(device: NetworkDevice): string {
  const connected = device.interfaces
    .filter((networkInterface) => networkInterface.enabled && isValidIPv4(networkInterface.ip) && isValidSubnetMask(networkInterface.mask))
    .map((networkInterface) => `C    ${networkInterface.ip}/${prefixFromMask(networkInterface.mask)} is directly connected, ${networkInterface.name}`);
  const staticRoutes = device.routes.map((route) => `S    ${route.network}/${prefixFromMask(route.mask)} [1/0] via ${route.nextHop || route.exitInterface}`);
  const ospfRoutes = device.ospfNetworks.map((network) => `O    ${network.network} ${network.wildcard} [110/2] area ${network.area}`);
  return ["Codes: C - connected, S - static, O - OSPF", ...connected, ...staticRoutes, ...ospfRoutes].join("\n");
}

interface DhcpPoolConfig {
  device: NetworkDevice;
  name: string;
  network: string;
  mask: string;
  gateway: string;
  dnsServer: string;
}

interface ServiceCommandOutput {
  output: string;
  error: boolean;
}

function ipv4Number(address: string): number {
  return address.split(".").map(Number).reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function ipv4String(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function dhcpPools(state: NetworkState): DhcpPoolConfig[] {
  return state.devices.flatMap((device) => {
    const sections = [...new Set(device.configuredCommands
      .filter((entry) => /^ip dhcp pool /i.test(entry.section))
      .map((entry) => entry.section))];
    return sections.flatMap((section) => {
      const entries = device.configuredCommands.filter((entry) => entry.section === section);
      const network = entries.find((entry) => /^network /i.test(entry.command))?.command.split(/\s+/);
      const gateway = entries.find((entry) => /^default-router /i.test(entry.command))?.command.split(/\s+/)[1] ?? "";
      const dnsServer = entries.find((entry) => /^dns-server /i.test(entry.command))?.command.split(/\s+/)[1] ?? "";
      if (!network || !isValidIPv4(network[1] ?? "") || !isValidSubnetMask(network[2] ?? "")) return [];
      return [{
        device,
        name: section.slice("ip dhcp pool ".length),
        network: network[1],
        mask: network[2],
        gateway,
        dnsServer,
      }];
    });
  });
}

function poolServerInterface(state: NetworkState, pool: DhcpPoolConfig, client: NetworkDevice): NetworkInterface | undefined {
  const path = findLanPath(state, client.id, pool.device.id, hostVlan(state, client.id));
  if (!path) return undefined;
  const networkInterface = interfaceAtPathEnd(state, pool.device, path.cableIds);
  return networkInterface && networkInterface.enabled && isValidIPv4(networkInterface.ip) ? networkInterface : undefined;
}

function acquireDhcpLease(state: NetworkState, client: NetworkDevice): ServiceCommandOutput {
  const pools = dhcpPools(state);
  let availablePool: DhcpPoolConfig | undefined;
  let leaseGateway = "";
  for (const pool of pools) {
    const serviceInterface = poolServerInterface(state, pool, client);
    if (serviceInterface && sameSubnet(serviceInterface.ip, pool.network, pool.mask)) {
      availablePool = pool;
      leaseGateway = pool.gateway;
      break;
    }
  }

  if (!availablePool) {
    for (const relay of state.devices.filter((device) => isRouterDevice(device.kind))) {
      const clientPath = findLanPath(state, client.id, relay.id, hostVlan(state, client.id));
      if (!clientPath) continue;
      const clientFacingInterface = interfaceAtPathEnd(state, relay, clientPath.cableIds);
      if (!clientFacingInterface) continue;
      const helper = relay.configuredCommands.find(
        (entry) => entry.section === `interface ${clientFacingInterface.name}` && /^ip helper-address /i.test(entry.command),
      )?.command.split(/\s+/)[2];
      if (!helper) continue;
      const pool = pools.find((candidate) =>
        candidate.device.interfaces.some((networkInterface) => networkInterface.enabled && networkInterface.ip === helper)
        && findLanPath(state, relay.id, candidate.device.id, hostVlan(state, client.id)) !== null,
      );
      if (!pool) continue;
      const relayInterface = relay.interfaces.find((networkInterface) =>
        networkInterface.name === clientFacingInterface.name,
      );
      if (relayInterface && sameSubnet(relayInterface.ip, pool.network, pool.mask)) {
        availablePool = pool;
        leaseGateway = pool.gateway || relayInterface?.ip || "";
        break;
      }
    }
  }

  if (!availablePool) return { output: "No reachable DHCP pool. Connect a configured DHCP server to this LAN or configure an ip helper-address relay.", error: true };
  if (client.dhcpLease?.poolName === availablePool.name) {
    client.gateway = leaseGateway || availablePool.gateway;
    client.dnsServer = availablePool.dnsServer;
    client.dhcpLease = {
      ...client.dhcpLease,
      gateway: client.gateway,
      dnsServer: client.dnsServer,
    };
    return { output: `DHCP lease renewed: ${client.dhcpLease.address} ${client.dhcpLease.mask}${client.gateway ? `, gateway ${client.gateway}` : ""}${client.dnsServer ? `, DNS ${client.dnsServer}` : ""}.`, error: false };
  }
  const prefix = prefixFromMask(availablePool.mask);
  const subnet = prefix === null ? null : subnetInfo(`${availablePool.network}/${prefix}`);
  if (!subnet) return { output: `DHCP pool ${availablePool.name} has an invalid network or mask.`, error: true };
  const excluded = availablePool.device.configuredCommands
    .filter((entry) => /^ip dhcp excluded-address /i.test(entry.command))
    .map((entry) => entry.command.split(/\s+/).slice(3).map(ipv4Number));
  const assigned = new Set(state.devices.flatMap((device) => device.interfaces.map((networkInterface) => networkInterface.ip)).filter(Boolean));
  const lower = ipv4Number(subnet.firstHost);
  const upper = ipv4Number(subnet.lastHost);
  const limit = Math.min(upper, lower + 4095);
  let address = "";
  for (let candidate = lower; candidate <= limit; candidate += 1) {
    const candidateIp = ipv4String(candidate);
    if (
      !assigned.has(candidateIp) &&
      candidateIp !== availablePool.gateway &&
      !excluded.some(([start, end]) => candidate >= start && candidate <= (end ?? start))
    ) {
      address = candidateIp;
      break;
    }
  }
  if (!address) return { output: `DHCP pool ${availablePool.name} has no free addresses.`, error: true };
  const networkInterface = hostInterface(state, client);
  if (!networkInterface) return { output: "This device has no network interface for DHCP.", error: true };
  networkInterface.ip = address;
  networkInterface.mask = availablePool.mask;
  client.gateway = leaseGateway || availablePool.gateway;
  client.dnsServer = availablePool.dnsServer;
  client.dhcpLease = {
    address,
    mask: availablePool.mask,
    gateway: client.gateway,
    dnsServer: client.dnsServer,
    poolName: availablePool.name,
  };
  return { output: `DHCP lease acquired: ${address} ${availablePool.mask}${client.gateway ? `, gateway ${client.gateway}` : ""}${client.dnsServer ? `, DNS ${client.dnsServer}` : ""} (pool ${availablePool.name}).`, error: false };
}

function shareFiles(device: NetworkDevice, share: string): string[] {
  return device.configuredCommands
    .filter((entry) => entry.section === `share ${share}` && /^file /i.test(entry.command))
    .map((entry) => entry.command.slice("file ".length));
}

function showVlanBrief(device: NetworkDevice): string {
  const vlans = [{ id: 1, name: "default" }, ...device.vlans.filter((vlan) => vlan.id !== 1)]
    .sort((a, b) => a.id - b.id);
  return [
    "VLAN Name                             Status    Ports",
    ...vlans.map((vlan) => {
      const ports = device.interfaces
        .filter((networkInterface) => !/^vlan\d+$/i.test(networkInterface.name) && !/^po\d+$/i.test(networkInterface.name) && networkInterface.mode === "access" && networkInterface.accessVlan === vlan.id)
        .map((networkInterface) => networkInterface.name)
        .join(",");
      return `${String(vlan.id).padEnd(5)} ${vlan.name.padEnd(32)} active    ${ports || "--"}`;
    }),
  ].join("\n");
}

function showTrunks(device: NetworkDevice): string {
  const trunks = device.interfaces.filter((networkInterface) => networkInterface.mode === "trunk");
  if (trunks.length === 0) return "No trunking interfaces are active.";
  const nativeVlan = (networkInterface: NetworkInterface) => device.configuredCommands.find(
    (entry) => entry.section === `interface ${networkInterface.name}` && entry.command.toLowerCase().startsWith("switchport trunk native vlan "),
  )?.command.split(/\s+/).at(-1) ?? "1";
  return [
    "Port      Mode       Encapsulation  Status        Native vlan",
    ...trunks.map((networkInterface) => `${networkInterface.name.padEnd(10)} on         802.1q         trunking      ${nativeVlan(networkInterface)}`),
    "",
    "Port      Vlans allowed on trunk",
    ...trunks.map((networkInterface) => `${networkInterface.name.padEnd(10)} ${networkInterface.allowedVlans.includes(0) ? "1-4094 (all)" : networkInterface.allowedVlans.join(",") || "none"}`),
  ].join("\n");
}

function runSubnet(commandParts: string[], context: CliContext, interfaceName: string): CommandResult {
  let cidr: string;
  if (commandParts[1]?.includes("/")) {
    cidr = commandParts[1];
  } else if (commandParts[1] && commandParts[2]) {
    const prefix = prefixFromMask(commandParts[2]);
    if (prefix === null) return invalid("Invalid subnet mask.", context, interfaceName);
    cidr = `${commandParts[1]}/${prefix}`;
  } else {
    return invalid("Usage: subnet IPv4/PREFIX or subnet IPv4 SUBNET-MASK", context, interfaceName);
  }
  const result = subnetInfo(cidr);
  if (!result) return invalid("Invalid IPv4 address or prefix. Prefix must be 0–32.", context, interfaceName);
  return success(
    `Network: ${result.network}/${result.prefix}\nMask: ${result.mask}\nFirst host: ${result.firstHost}\nLast host: ${result.lastHost}\nBroadcast: ${result.broadcast}\nAddresses: ${result.totalAddresses}\nUsable hosts: ${result.usableHosts}`,
    context,
    interfaceName,
  );
}

export function executeNetworkCommand(
  state: NetworkState,
  device: NetworkDevice,
  rawCommand: string,
  initialContext: CliContext,
  initialInterfaceName: string,
): CommandResult {
  const parts = rawCommand.trim().split(/\s+/);
  const lower = parts.map((part) => part.toLowerCase());
  let context = initialContext;
  let interfaceName = initialInterfaceName;
  const currentInterfaces = () => {
    const selectedNames = interfaceName.split(",").map((name) => name.trim().toLowerCase());
    return device.interfaces.filter((networkInterface) => selectedNames.includes(networkInterface.name.toLowerCase()));
  };
  const currentInterface = () => currentInterfaces()[0];
  const enterMode = (mode: CliMode, target?: string): CliContext => ({
    mode,
    target,
    parent: context,
  });
  const needGlobal = () => {
    if (context.mode === "global") return true;
    const message =
      context.mode === "privileged"
        ? "Enter configuration mode first: configure terminal"
        : context.mode === "user"
          ? "Use enable, then configure terminal."
          : "Use exit to return to global configuration mode first.";
    return invalid(message, context, interfaceName);
  };

  if (lower[0] === "help" || lower[0] === "?") return success(helpText, context, interfaceName);
  if (lower[0] === "enable" && lower[1] === "secret" && context.mode === "global") {
    if (!parts[2]) return invalid("Usage: enable secret PASSWORD", context, interfaceName);
    rememberCommand(device, "", parts.join(" "));
    return success("Privileged EXEC secret configured (stored only in this local simulation).", context, interfaceName);
  }
  if (lower[0] === "enable" || lower[0] === "en") return success("Privileged EXEC mode enabled.", { mode: "privileged" }, interfaceName);
  if (lower[0] === "disable" && context.mode === "privileged") return success("User EXEC mode.", { mode: "user" }, interfaceName);
  if (
    (lower[0] === "configure" && (lower[1] === "terminal" || lower[1] === "t")) ||
    (lower[0] === "conf" && lower[1] === "t")
  ) {
    if (context.mode !== "privileged" && context.mode !== "global") return invalid("Use enable before entering configuration mode.", context, interfaceName);
    return success("Enter configuration commands. End with end or exit.", { mode: "global" }, interfaceName);
  }
  if (lower[0] === "end") return success("Returned to privileged EXEC mode.", { mode: "privileged" }, interfaceName);
  if (lower[0] === "exit") {
    const nextContext = context.parent ?? {
      mode: context.mode === "global" ? "privileged" : context.mode === "privileged" ? "user" : "global",
    };
    return success("Exited current configuration mode.", nextContext, interfaceName);
  }
  if (lower[0] === "subnet") return runSubnet(parts, context, interfaceName);

  if (lower[0] === "wireless" && lower[1] === "connect") {
    if (device.kind !== "laptop") return invalid("Wireless client association is supported from a laptop terminal.", context, interfaceName);
    const passwordIndex = lower.indexOf("password");
    const ssid = passwordIndex > 2 ? parts.slice(2, passwordIndex).join(" ") : "";
    const password = passwordIndex >= 0 ? parts.slice(passwordIndex + 1).join(" ") : "";
    if (!ssid || passwordIndex < 3 || !password) return invalid("Usage: wireless connect SSID password PASSWORD", context, interfaceName);
    const accessPoint = state.devices.find((candidate) =>
      candidate.kind === "wireless-router" &&
      candidate.configuredCommands.some((entry) => entry.section === "wireless" && entry.command === `wireless ssid ${ssid}`) &&
      candidate.configuredCommands.some((entry) => entry.section === "wireless" && entry.command === `wireless password ${password}`),
    );
    const clientWifi = device.interfaces.find((networkInterface) => networkInterface.name === "wlan0");
    const routerWifi = accessPoint?.interfaces.find((networkInterface) => networkInterface.name === "wlan0");
    if (!accessPoint || !clientWifi?.enabled || !routerWifi?.enabled) {
      return invalid("No matching powered-on wireless router was found. Check the SSID, password, and wlan0 interface status.", context, interfaceName);
    }
    state.cables = state.cables.filter((cable) => !(cable.from === device.id && cable.fromInterface === "wlan0") && !(cable.to === device.id && cable.toInterface === "wlan0"));
    state.cables.push({
      id: `wireless-${crypto.randomUUID()}`,
      from: accessPoint.id,
      to: device.id,
      fromInterface: "wlan0",
      toInterface: "wlan0",
      medium: "wireless",
    });
    return success(`${device.name} associated with ${ssid} on ${accessPoint.name}. Use ipconfig /renew to request a DHCP lease.`, context, interfaceName);
  }

  if (lower[0] === "nslookup") {
    if (!isHostDevice(device.kind) || !parts[1]) return invalid("Usage: nslookup HOSTNAME (run this from a PC, laptop, server, or NAS terminal).", context, interfaceName);
    const dnsAddress = device.dnsServer || device.dhcpLease?.dnsServer || "";
    const dnsServer = state.devices.find((candidate) =>
      candidate.interfaces.some((networkInterface) => networkInterface.ip === dnsAddress && networkInterface.enabled),
    );
    if (!dnsServer || !simulatePing(state, device.id, dnsAddress).ok) {
      return invalid(`DNS server ${dnsAddress || "(not configured)"} is unreachable. Configure DHCP DNS or set a DNS server first.`, context, interfaceName);
    }
    const record = dnsServer.configuredCommands.find(
      (entry) => entry.section === "dns" && entry.command.toLowerCase().startsWith(`dns record ${parts[1].toLowerCase()} `),
    );
    const address = record?.command.split(/\s+/).at(-1);
    return address
      ? success(`Server: ${dnsAddress}\nName: ${parts[1]}\nAddress: ${address}`, context, interfaceName)
      : invalid(`No DNS record found for ${parts[1]}.`, context, interfaceName);
  }

  if (lower[0] === "nas") {
    if (!isHostDevice(device.kind) || !["list", "read", "write"].includes(lower[1] ?? "") || !isValidIPv4(parts[2] ?? "") || !parts[3]) {
      return invalid("Usage: nas list|read|write NAS-IP SHARE [FILE [CONTENT]]", context, interfaceName);
    }
    const nas = state.devices.find((candidate) =>
      candidate.kind === "nas" && candidate.interfaces[0]?.ip === parts[2],
    );
    if (!nas || !simulatePing(state, device.id, parts[2]).ok) return invalid(`NAS ${parts[2]} is not reachable. Check its IP address and the network path.`, context, interfaceName);
    const share = parts[3];
    if (!nas.configuredCommands.some((entry) => entry.section === `share ${share}`)) return invalid(`Share "${share}" does not exist on ${nas.name}.`, context, interfaceName);
    if (lower[1] === "list") return success(shareFiles(nas, share).join("\n") || `Share ${share} is empty.`, context, interfaceName);
    const fileName = parts[4];
    if (!fileName) return invalid(`Usage: nas ${lower[1]} ${parts[2]} ${share} FILE${lower[1] === "write" ? " CONTENT" : ""}`, context, interfaceName);
    const existing = nas.configuredCommands.find(
      (entry) => entry.section === `share ${share}` && entry.command.startsWith(`file ${fileName} `),
    );
    if (lower[1] === "read") {
      return existing
        ? success(existing.command.slice(`file ${fileName} `.length), context, interfaceName)
        : invalid(`File "${fileName}" does not exist in share ${share}.`, context, interfaceName);
    }
    const content = parts.slice(5).join(" ");
    if (!content) return invalid("A non-empty file body is required.", context, interfaceName);
    nas.configuredCommands = nas.configuredCommands.filter(
      (entry) => entry.section !== `share ${share}` || !entry.command.startsWith(`file ${fileName} `),
    );
    rememberCommand(nas, `share ${share}`, `file ${fileName} ${content}`);
    return success(`Wrote ${fileName} to ${nas.name}:${share}.`, context, interfaceName);
  }

  if (device.kind === "nas" && lower[0] === "share") {
    if (lower[1] === "create" && parts[2]) {
      rememberCommand(device, `share ${parts[2]}`, `share ${parts[2]}`);
      return success(`Storage share ${parts[2]} created.`, context, interfaceName);
    }
    if (lower[1] === "list" && parts[2]) {
      if (!device.configuredCommands.some((entry) => entry.section === `share ${parts[2]}`)) return invalid(`Share "${parts[2]}" does not exist.`, context, interfaceName);
      return success(shareFiles(device, parts[2]).join("\n") || `Share ${parts[2]} is empty.`, context, interfaceName);
    }
    if (lower[1] === "write" && parts[2] && parts[3] && parts.slice(4).length > 0) {
      const share = parts[2];
      if (!device.configuredCommands.some((entry) => entry.section === `share ${share}`)) return invalid(`Share "${share}" does not exist.`, context, interfaceName);
      const fileName = parts[3];
      device.configuredCommands = device.configuredCommands.filter(
        (entry) => entry.section !== `share ${share}` || !entry.command.startsWith(`file ${fileName} `),
      );
      rememberCommand(device, `share ${share}`, `file ${fileName} ${parts.slice(4).join(" ")}`);
      return success(`Wrote ${fileName} to share ${share}.`, context, interfaceName);
    }
    if (lower[1] === "read" && parts[2] && parts[3]) {
      const content = device.configuredCommands.find(
        (entry) => entry.section === `share ${parts[2]}` && entry.command.startsWith(`file ${parts[3]} `),
      )?.command.slice(`file ${parts[3]} `.length);
      return content === undefined ? invalid(`File "${parts[3]}" was not found.`, context, interfaceName) : success(content, context, interfaceName);
    }
  }

  if (lower[0] === "dns" && lower[1] === "record" && device.kind === "server") {
    const hostname = parts[2]?.toLowerCase();
    if (!hostname || !isValidIPv4(parts[3] ?? "")) return invalid("Usage: dns record HOSTNAME IPv4-ADDRESS", context, interfaceName);
    device.configuredCommands = device.configuredCommands.filter(
      (entry) => entry.section !== "dns" || !entry.command.toLowerCase().startsWith(`dns record ${hostname} `),
    );
    rememberCommand(device, "dns", `dns record ${hostname} ${parts[3]}`);
    return success(`DNS A record created: ${hostname} → ${parts[3]}.`, context, interfaceName);
  }

  if (
    lower[0] === "write" && lower[1] === "memory" ||
    lower[0] === "copy" && ["running-config", "run"].includes(lower[1] ?? "") && ["startup-config", "start"].includes(lower[2] ?? "")
  ) {
    device.startupConfig = renderRunningConfig(device);
    return success("Building configuration...\n[OK] Configuration saved to simulated startup-config.", context, interfaceName);
  }
  if (lower[0] === "erase" && lower[1] === "startup-config") {
    device.startupConfig = null;
    return success("Erasing the startup configuration...\n[OK] Simulated startup-config erased.", context, interfaceName);
  }
  if (lower[0] === "reload") {
    return success(
      device.startupConfig
        ? "Proceeding with simulated reload. Saved startup-config is retained; the topology remains in place."
        : "Proceeding with simulated reload. No startup-config is saved; current running configuration is retained in this simulator.",
      context,
      interfaceName,
    );
  }
  if (lower[0] === "undebug" && lower[1] === "all" || lower[0] === "no" && lower[1] === "debug" && lower[2] === "all") {
    device.debugging = [];
    return success("All simulated debugging disabled.", context, interfaceName);
  }
  if (lower[0] === "debug" && lower[1] === "ip" && ["icmp", "ospf"].includes(lower[2] ?? "")) {
    const debugCommand = lower[2] === "icmp" && parts.length === 3
      ? "debug ip icmp"
      : lower[2] === "ospf" && lower[3] === "events" && parts.length === 4
        ? "debug ip ospf events"
        : "";
    if (debugCommand) {
      if (!device.debugging.includes(debugCommand)) device.debugging.push(debugCommand);
      return success(`Simulated debugging enabled: ${debugCommand}.`, context, interfaceName);
    }
    return invalid("Supported debug commands: debug ip icmp, debug ip ospf events.", context, interfaceName);
  }

  if ((lower[0] === "ping" && parts[1]) || lower[0] === "ping") {
    if (!isHostDevice(device.kind)) return invalid("Ping from this terminal is supported on end devices.", context, interfaceName);
    if (!parts[1]) return invalid("Usage: ping DESTINATION-IP", context, interfaceName);
    const ping = simulatePing(state, device.id, parts[1]);
    return { output: ping.message, error: !ping.ok, context, interfaceName, ping };
  }
  if (lower[0] === "traceroute" && parts[1]) {
    if (!isHostDevice(device.kind)) return invalid("Traceroute is supported from end devices.", context, interfaceName);
    const result = simulatePing(state, device.id, parts[1]);
    const hops = result.ok ? result.path.map((hop, index) => `${index + 1}  ${hop}`).join("\n") : `1  *\n${result.message}`;
    return { output: `Tracing route to ${parts[1]}\n${hops}\n${result.ok ? "Trace complete." : "Trace incomplete."}`, error: !result.ok, context, interfaceName, ping: result };
  }

  if ((lower[0] === "ipconfig" || lower[0] === "ifconfig") && isHostDevice(device.kind)) {
    const networkInterface = hostInterface(state, device);
    if (!networkInterface) return invalid("This device has no active network interface.", context, interfaceName);
    if (["/renew", "renew"].includes(lower[1] ?? "")) {
      const lease = acquireDhcpLease(state, device);
      return lease.error ? invalid(lease.output, context, interfaceName) : success(lease.output, context, interfaceName);
    }
    if (["/release", "release"].includes(lower[1] ?? "")) {
      if (!device.dhcpLease) return invalid("No DHCP lease is active on this device.", context, interfaceName);
      networkInterface.ip = "";
      networkInterface.mask = "";
      device.gateway = "";
      device.dnsServer = "";
      device.dhcpLease = null;
      return success("DHCP lease released.", context, interfaceName);
    }
    if (parts.length >= 3) {
      if (!isValidIPv4(parts[1]) || !isValidSubnetMask(parts[2]) || (parts[3] && !isValidIPv4(parts[3])) || (parts[4] && !isValidIPv4(parts[4]))) {
        return invalid("Usage: ipconfig IPv4 SUBNET-MASK [DEFAULT-GATEWAY [DNS-SERVER]]", context, interfaceName);
      }
      networkInterface.ip = parts[1];
      networkInterface.mask = parts[2];
      if (parts[3]) device.gateway = parts[3];
      if (parts[4]) device.dnsServer = parts[4];
      device.dhcpLease = null;
      return success(`IPv4 settings configured on ${networkInterface.name}.`, context, interfaceName);
    }
    return success(`Interface: ${networkInterface.name}\nIPv4 Address: ${networkInterface.ip || "not set"}${device.dhcpLease ? " (DHCP)" : ""}\nSubnet Mask: ${networkInterface.mask || "not set"}\nDefault Gateway: ${device.gateway || "not set"}\nDNS Server: ${device.dnsServer || "not set"}${device.dhcpLease ? `\nDHCP Pool: ${device.dhcpLease.poolName}` : ""}`, context, interfaceName);
  }

  if (lower[0] === "ip" && lower[1] === "default-gateway" && isHostDevice(device.kind)) {
    const global = needGlobal();
    if (global !== true) return global;
    if (!isValidIPv4(parts[2] ?? "")) return invalid("Usage: ip default-gateway IPv4-ADDRESS", context, interfaceName);
    device.gateway = parts[2];
    device.dhcpLease = null;
    return success(`Default gateway set to ${device.gateway}.`, context, interfaceName);
  }
  if (lower[0] === "ip" && lower[1] === "name-server" && isHostDevice(device.kind)) {
    const global = needGlobal();
    if (global !== true) return global;
    if (!isValidIPv4(parts[2] ?? "")) return invalid("Usage: ip name-server IPv4-ADDRESS", context, interfaceName);
    device.dnsServer = parts[2];
    device.dhcpLease = null;
    return success(`DNS server set to ${device.dnsServer}.`, context, interfaceName);
  }

  if (lower[0] === "show") {
    if (lower[1] === "running-config" || lower[1] === "run") {
      return success(renderRunningConfig(device), context, interfaceName);
    }
    if (lower[1] === "startup-config" || lower[1] === "start") return success(device.startupConfig ?? "No startup-config is saved.", context, interfaceName);
    if (
      (lower[1] === "ip" && lower[2] === "interface" && lower[3] === "brief") ||
      (lower[1] === "ip" && lower[2] === "int" && lower[3] === "brief")
    ) {
      return success(
        ["Interface          IP-Address       Status                  Protocol", ...device.interfaces.map((networkInterface) => `${networkInterface.name.padEnd(19)} ${(networkInterface.ip || "unassigned").padEnd(17)} ${(networkInterface.enabled ? "up" : "administratively down").padEnd(24)} ${networkInterface.enabled ? (state.cables.some((cable) => cable.from === device.id && cable.fromInterface === networkInterface.name || cable.to === device.id && cable.toInterface === networkInterface.name) ? "up" : "down") : "down"}`)].join("\n"),
        context,
        interfaceName,
      );
    }
    if (lower.slice(1, 3).join(" ") === "ip route") return success(routeTable(device), context, interfaceName);
    if (lower.slice(1, 3).join(" ") === "ipv6 route") {
      const routes = device.configuredCommands.filter((entry) => entry.command.toLowerCase().startsWith("ipv6 route "));
      return success(["IPv6 Routing Table", ...routes.map((entry) => `S ${entry.command.slice(12)}`)].join("\n"), context, interfaceName);
    }
    if (lower[1] === "version") return success("NetLab IOS-compatible simulator\nSoftware: NetLab 1.0 (educational simulation)\nDevice: " + device.kind + "\nNo real Cisco IOS software or hardware is present.", context, interfaceName);
    if (lower[1] === "interfaces" && lower[2] !== "trunk" && lower[2] !== "switchport") {
      return success(device.interfaces.map((networkInterface) =>
        `${networkInterface.name} is ${networkInterface.enabled ? "up" : "administratively down"}, line protocol is ${networkInterface.enabled && state.cables.some((cable) => (cable.from === device.id && cable.fromInterface === networkInterface.name) || (cable.to === device.id && cable.toInterface === networkInterface.name)) ? "up" : "down"}\n  Internet address is ${networkInterface.ip || "not set"}${networkInterface.mask ? `/${prefixFromMask(networkInterface.mask)}` : ""}\n  Description: ${device.configuredCommands.find((entry) => entry.section === `interface ${networkInterface.name}` && entry.command.toLowerCase().startsWith("description "))?.command.slice(12) ?? "none"}`,
      ).join("\n"), context, interfaceName);
    }
    if (lower[1] === "ipv6" && lower[2] === "interface" && lower[3] === "brief") {
      const addresses = device.interfaces.map((networkInterface) => {
        const address = device.configuredCommands.find((entry) => entry.section === `interface ${networkInterface.name}` && entry.command.toLowerCase().startsWith("ipv6 address "));
        return `${networkInterface.name.padEnd(18)} ${address?.command.slice(13) ?? "unassigned"} ${networkInterface.enabled ? "up" : "administratively down"}`;
      });
      return success(["Interface          IPv6 Address                       Status", ...addresses].join("\n"), context, interfaceName);
    }
    if (lower[1] === "controllers") return success(`Controller details for ${parts.slice(2).join(" ") || "all interfaces"}\nHardware statistics are simulated; no physical controller is attached.`, context, interfaceName);
    if (lower[1] === "etherchannel" && lower[2] === "summary") {
      const channels = device.configuredCommands.filter((entry) => entry.command.toLowerCase().startsWith("channel-group "));
      const groups = new Map<string, string[]>();
      channels.forEach((entry) => {
        const group = entry.command.split(" ")[1];
        const ports = groups.get(group) ?? [];
        ports.push(entry.section.replace("interface ", ""));
        groups.set(group, ports);
      });
      return success(["Group  Port-channel  Protocol  Ports", ...(groups.size ? [...groups.entries()].map(([group, ports]) => `${group.padEnd(7)} Po${group.padEnd(13)} simulated  ${[...new Set(ports)].join(",")}`) : ["No EtherChannels configured."])].join("\n"), context, interfaceName);
    }
    if (lower.slice(1, 4).join(" ") === "ip dhcp binding") {
      const leases = state.devices.filter((candidate) => candidate.dhcpLease);
      return success([
        "IP address       Device       Pool",
        ...leases.map((candidate) => `${candidate.dhcpLease?.address.padEnd(17)}${candidate.name.padEnd(13)}${candidate.dhcpLease?.poolName}`),
        ...(leases.length ? [] : ["No active DHCP leases."]),
      ].join("\n"), context, interfaceName);
    }
    if (lower.slice(1, 3).join(" ") === "dns records") {
      const records = device.configuredCommands.filter((entry) => entry.section === "dns" && /^dns record /i.test(entry.command));
      return success(["Hostname                         IPv4 Address", ...records.map((entry) => {
        const [hostname, address] = entry.command.slice("dns record ".length).split(/\s+/);
        return `${(hostname ?? "").padEnd(33)}${address ?? ""}`;
      })].join("\n"), context, interfaceName);
    }
    if (lower[1] === "wireless") {
      const ssid = device.configuredCommands.find((entry) => entry.section === "wireless" && entry.command.startsWith("wireless ssid "))?.command.slice("wireless ssid ".length);
      const clients = state.cables
        .filter((cable) => cable.medium === "wireless" && (cable.from === device.id || cable.to === device.id))
        .map((cable) => state.devices.find((candidate) => candidate.id === (cable.from === device.id ? cable.to : cable.from))?.name)
        .filter((name): name is string => Boolean(name));
      return success(`Wireless LAN ${ssid ?? "(SSID not configured)"}\nRadio: ${device.interfaces.find((networkInterface) => networkInterface.name === "wlan0")?.enabled ? "up" : "down"}\nAssociated clients: ${clients.join(", ") || "none"}`, context, interfaceName);
    }
    if (lower.slice(1, 4).join(" ") === "ip nat translations") {
      const translations = device.natTranslations;
      return success([
        "Pro  Inside global       Inside local        Outside local      Outside global",
        ...translations.map((entry) => `${entry.protocol.toUpperCase().padEnd(5)}${entry.insideGlobal.padEnd(20)}${entry.insideLocal.padEnd(20)}${entry.outsideLocal.padEnd(19)}${entry.outsideGlobal}`),
        ...(translations.length ? [] : ["No active simulated NAT translations. Ping a cloud endpoint from an inside host to create one."]),
      ].join("\n"), context, interfaceName);
    }
    if (lower.slice(1, 3).join(" ") === "standby brief") {
      const standby = device.configuredCommands.filter((entry) => entry.command.toLowerCase().startsWith("standby ") && entry.command.toLowerCase().includes(" ip "));
      return success(["Interface  Grp  Pri  State   Virtual IP", ...(standby.length ? standby.map((entry) => {
        const group = entry.command.split(" ")[1];
        const priority = device.configuredCommands.find((setting) => setting.section === entry.section && setting.command.toLowerCase().startsWith(`standby ${group} priority `))?.command.split(" ").at(-1) ?? "100";
        const virtualIp = entry.command.split(" ")[3] ?? "unknown";
        return `${entry.section.replace("interface ", "")}  ${group}  ${priority}  Active*  ${virtualIp}`;
      }) : ["No HSRP/VRRP groups configured."])].join("\n"), context, interfaceName);
    }
    if (lower.slice(1, 4).join(" ") === "ip ospf neighbor") return success("Neighbor ID       State        Address       Interface\nNo OSPF adjacencies are currently simulated.", context, interfaceName);
    if (lower.slice(1, 4).join(" ") === "ip ospf interface") return success(device.interfaces.map((networkInterface) => `${networkInterface.name}\n  OSPF process ${device.ospfProcess ?? "not enabled"}\n  Configured network statements: ${device.ospfNetworks.length}`).join("\n"), context, interfaceName);
    if (lower.slice(1, 4).join(" ") === "ip eigrp neighbors") return success("EIGRP-IPv4 Neighbors\nNo EIGRP adjacencies are currently simulated.", context, interfaceName);
    if (lower.slice(1, 4).join(" ") === "ip bgp summary") {
      const peers = device.configuredCommands.filter((entry) => entry.command.toLowerCase().startsWith("neighbor ") && entry.command.toLowerCase().includes("remote-as"));
      return success(["BGP router identifier, local AS number simulated", "Neighbor        V    AS    MsgRcvd MsgSent State/PfxRcd", ...(peers.length ? peers.map((entry) => `${entry.command.split(" ")[1]}  4  ${entry.command.split(" ")[3]}    0       0       Idle (simulated)`) : ["No BGP neighbors configured."])].join("\n"), context, interfaceName);
    }
    if (lower[1] === "lldp" && lower[2] === "neighbors" || lower[1] === "cdp" && lower[2] === "neighbors") {
      const peers = state.cables.filter((cable) => cable.from === device.id || cable.to === device.id).map((cable) => {
        const localPort = cable.from === device.id ? cable.fromInterface : cable.toInterface;
        const peerId = cable.from === device.id ? cable.to : cable.from;
        const peerPort = cable.from === device.id ? cable.toInterface : cable.fromInterface;
        const peer = state.devices.find((item) => item.id === peerId);
        return `${peer?.name ?? "unknown"}    ${localPort}    ${peerPort}${lower[3] === "detail" ? `\n  Platform: simulated ${peer?.kind ?? "device"}\n  Management address: ${peer?.interfaces.find((item) => isValidIPv4(item.ip))?.ip ?? "not configured"}` : ""}`;
      });
      return success(["Device ID       Local Interface    Remote Interface", ...(peers.length ? peers : ["<no neighbors discovered>"])].join("\n"), context, interfaceName);
    }
    if (lower.slice(1, 3).join(" ") === "ip protocols") {
      return success(
        device.ospfProcess === null
          ? "Routing Protocol is not enabled on this device."
          : `Routing Protocol is "ospf ${device.ospfProcess}"\nRouter ID: ${device.interfaces.find((networkInterface) => isValidIPv4(networkInterface.ip))?.ip ?? "not set"}\nConfigured networks:\n${device.ospfNetworks.map((network) => `  ${network.network} ${network.wildcard} area ${network.area}`).join("\n") || "  none"}`,
        context,
        interfaceName,
      );
    }
    if (lower.slice(1, 3).join(" ") === "vlan brief" && device.kind === "switch") return success(showVlanBrief(device), context, interfaceName);
    if (lower.slice(1, 3).join(" ") === "interfaces trunk" && device.kind === "switch") return success(showTrunks(device), context, interfaceName);
    if (lower.slice(1, 3).join(" ") === "interfaces switchport" && device.kind === "switch") {
      return success(device.interfaces.filter((networkInterface) => !/^vlan\d+$/i.test(networkInterface.name)).map((networkInterface) => {
        const config = device.configuredCommands.filter((entry) => entry.section === `interface ${networkInterface.name}`);
        const nativeVlan = config.find((entry) => entry.command.toLowerCase().startsWith("switchport trunk native vlan "))?.command.split(" ").at(-1) ?? "1";
        const security = config.filter((entry) => entry.command.toLowerCase().startsWith("switchport port-security")).map((entry) => entry.command).join("; ") || "disabled";
        const fast = config.some((entry) => entry.command.toLowerCase() === "spanning-tree portfast");
        return `${networkInterface.name}\n  Administrative Mode: static ${networkInterface.mode}\n  Operational Mode: ${networkInterface.mode}\n  Access Mode VLAN: ${networkInterface.accessVlan}\n  Native VLAN: ${nativeVlan}\n  Trunking VLANs: ${networkInterface.allowedVlans.includes(0) ? "1-4094 (all)" : networkInterface.allowedVlans.join(",")}\n  Port Security: ${security}${fast ? "\n  PortFast: enabled" : ""}`;
      }).join("\n\n"), context, interfaceName);
    }
    if (lower.slice(1, 4).join(" ") === "mac address-table" && device.kind === "switch") {
      const entries = state.cables
        .filter((cable) => cable.from === device.id || cable.to === device.id)
        .map((cable) => {
          const ownPort = cable.from === device.id ? cable.fromInterface : cable.toInterface;
          const peerId = cable.from === device.id ? cable.to : cable.from;
          const peer = state.devices.find((item) => item.id === peerId);
          const peerInterfaceName = cable.from === device.id ? cable.toInterface : cable.fromInterface;
          const peerInterface = peer?.interfaces.find((item) => item.name === peerInterfaceName);
          const vlanId = peer?.kind === "switch" ? peerInterface?.accessVlan ?? 1 : device.interfaces.find((item) => item.name === ownPort)?.accessVlan ?? 1;
          return ` ${String(vlanId).padEnd(5)} ${peer?.name ?? "unknown"} DYNAMIC ${ownPort}`;
        });
      return success(["Vlan    Mac Address       Type       Ports", ...(entries.length ? entries : ["<no dynamic entries>"])].join("\n"), context, interfaceName);
    }
    if (lower[1] === "spanning-tree" && device.kind === "switch") {
      const vlanIndex = lower.indexOf("vlan");
      const vlanId = vlanIndex >= 0 ? parts[vlanIndex + 1] : "1";
      const stpConfig = device.configuredCommands.find((entry) => entry.section === "" && entry.command.toLowerCase() === `spanning-tree vlan ${vlanId} root primary`) ??
        device.configuredCommands.find((entry) => entry.section === "" && entry.command.toLowerCase() === `spanning-tree vlan ${vlanId} root secondary`);
      const mode = device.configuredCommands.find((entry) => entry.section === "" && entry.command.toLowerCase().startsWith("spanning-tree mode "))?.command.split(" ").at(-1) ?? "pvst";
      const ports = device.interfaces.filter((networkInterface) => !/^vlan\d+$/i.test(networkInterface.name) && networkInterface.enabled).map((networkInterface) => networkInterface.name);
      return success(`VLAN ${vlanId} spanning-tree summary (${mode})\nRoot bridge: ${stpConfig ? `${device.name} (${stpConfig.command.endsWith("primary") ? "primary" : "secondary"}, simulated)` : `${device.name} (simulated)`}\nForwarding ports: ${ports.join(", ") || "none"}`, context, interfaceName);
    }
    return invalid(`Unsupported show command: "${rawCommand}". Type help for supported commands.`, context, interfaceName);
  }

  if (lower[0] === "hostname") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!parts[1]) return invalid("Usage: hostname NAME", context, interfaceName);
    device.hostname = parts.slice(1).join("-").slice(0, 24);
    device.name = device.hostname;
    return success(`Hostname changed to ${device.hostname}.`, context, interfaceName);
  }

  if ((lower[0] === "interface" || lower[0] === "int") && context.mode === "global") {
    const global = needGlobal();
    if (global !== true) return global;
    let selected: NetworkInterface[] = [];
    if (lower[1] === "range") {
      const rawRange = parts.slice(2).join(" ").replace(/\s*-\s*/g, "-");
      const match = rawRange.match(/^([a-z]+)(\d+\/)?(\d+)-(?:(?:[a-z]+\d*\/?)?)(\d+)$/i);
      if (!match) return invalid("Usage: interface range TYPE FIRST - LAST (example: interface range Fa0/1 - 4)", context, interfaceName);
      const [, rawType, rawSlot = "", first, last] = match;
      const prefix = normalizeInterfaceName(`${rawType}${rawSlot}`);
      const start = Number(first);
      const end = Number(last);
      if (end < start || end - start > 47) return invalid("Interface range must be ascending and contain at most 48 ports.", context, interfaceName);
      selected = device.interfaces.filter((item) => {
        const normalized = normalizeInterfaceName(item.name);
        const matchPort = normalized.match(/^([a-z]+\d*\/?)(\d+)$/);
        return matchPort?.[1] === prefix && Number(matchPort[2]) >= start && Number(matchPort[2]) <= end;
      });
    } else {
      const requestedName = lower[1] === "vlan" ? `Vlan${parts[2] ?? ""}` :
        lower[1] === "port-channel" ? `Po${parts[2] ?? ""}` : parts[1] ?? "";
      const normalized = normalizeInterfaceName(requestedName);
      let networkInterface = device.interfaces.find((item) => normalizeInterfaceName(item.name) === normalized);
      if (!networkInterface && /^vlan\d+$/i.test(requestedName) && device.kind === "switch") {
        const vlanId = Number(requestedName.slice(4));
        if (!isConfiguredVlan(device, vlanId)) return invalid(`VLAN ${vlanId} must exist before its SVI can be configured.`, context, interfaceName);
        networkInterface = createNetworkInterface(`Vlan${vlanId}`);
        networkInterface.enabled = false;
        device.interfaces.push(networkInterface);
      }
      if (!networkInterface && /^po\d+$/i.test(normalized)) {
        networkInterface = createNetworkInterface(requestedName);
        networkInterface.enabled = false;
        device.interfaces.push(networkInterface);
      }
      if (!networkInterface && /^\w+\/\d+\.\d+$/.test(requestedName)) {
        const parent = requestedName.split(".")[0];
        if (!device.interfaces.some((item) => normalizeInterfaceName(item.name) === normalizeInterfaceName(parent))) {
          return invalid(`Parent interface ${parent} does not exist.`, context, interfaceName);
        }
        networkInterface = createNetworkInterface(requestedName);
        networkInterface.enabled = false;
        device.interfaces.push(networkInterface);
      }
      if (networkInterface) selected = [networkInterface];
    }
    if (selected.length === 0) return invalid(`No matching interface found for "${parts.slice(1).join(" ")}".`, context, interfaceName);
    interfaceName = selected.map((item) => item.name).join(",");
    const mode = lower[1] === "range" ? "interface range" : "interface";
    return success(`Selected ${selected.length === 1 ? selected[0].name : `${selected.length} interfaces (${interfaceName})`}.`, { ...enterMode("interface", interfaceName), target: mode }, interfaceName);
  }

  if (lower[0] === "vlan" && device.kind === "switch" && context.mode === "global") {
    const global = needGlobal();
    if (global !== true) return global;
    const vlanId = Number(parts[1]);
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) return invalid("VLAN ID must be between 1 and 4094.", context, interfaceName);
    if (!device.vlans.some((vlan) => vlan.id === vlanId) && vlanId !== 1) device.vlans.push({ id: vlanId, name: `VLAN${vlanId}` });
    return success(`VLAN ${vlanId} selected.`, { ...enterMode("vlan", `vlan ${vlanId}`), vlanId }, interfaceName);
  }

  if (lower[0] === "no" && lower[1] === "vlan" && device.kind === "switch") {
    const global = needGlobal();
    if (global !== true) return global;
    const vlanId = Number(parts[2]);
    if (!Number.isInteger(vlanId) || vlanId <= 1 || vlanId > 4094) return invalid("Only VLAN IDs 2–4094 can be removed.", context, interfaceName);
    device.vlans = device.vlans.filter((vlan) => vlan.id !== vlanId);
    device.interfaces.forEach((networkInterface) => {
      if (networkInterface.accessVlan === vlanId) networkInterface.accessVlan = 1;
      if (!networkInterface.allowedVlans.includes(0)) networkInterface.allowedVlans = networkInterface.allowedVlans.filter((id) => id !== vlanId);
    });
    return success(`VLAN ${vlanId} removed. Ports assigned to it returned to VLAN 1.`, context, interfaceName);
  }

  if (lower[0] === "no" && lower[1] === "ip" && lower[2] === "route" && context.mode === "global") {
    const network = parts[3];
    const mask = parts[4];
    if (!isValidIPv4(network ?? "") || !isValidSubnetMask(mask ?? "")) {
      return invalid("Usage: no ip route NETWORK SUBNET-MASK", context, interfaceName);
    }
    device.routes = device.routes.filter((route) => route.network !== network || route.mask !== mask);
    return success(`Matching static route to ${network} removed.`, context, interfaceName);
  }

  if (lower[0] === "name" && context.mode === "vlan" && context.vlanId !== undefined) {
    const vlan = device.vlans.find((item) => item.id === context.vlanId);
    if (!vlan) return invalid("Selected VLAN does not exist.", context, interfaceName);
    vlan.name = parts.slice(1).join(" ").slice(0, 32);
    return vlan.name ? success(`VLAN ${vlan.id} named ${vlan.name}.`, context, interfaceName) : invalid("Usage: name VLAN-NAME", context, interfaceName);
  }

  if (lower[0] === "router" && lower[1] === "ospf" && isRouterDevice(device.kind)) {
    const global = needGlobal();
    if (global !== true) return global;
    const processId = Number(parts[2]);
    if (!Number.isInteger(processId) || processId < 1 || processId > 65535) return invalid("Usage: router ospf PROCESS-ID (1–65535)", context, interfaceName);
    device.ospfProcess = processId;
    return success(`OSPF process ${processId} started.`, enterMode("router-ospf", `router ospf ${processId}`), interfaceName);
  }

  if (lower[0] === "router" && lower[1] === "ospfv3") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!/^\d+$/.test(parts[2] ?? "")) return invalid("Usage: router ospfv3 PROCESS-ID", context, interfaceName);
    const section = `router ospfv3 ${parts[2]}`;
    rememberCommand(device, section, `router ospfv3 ${parts[2]}`);
    return success(`OSPFv3 process ${parts[2]} started (configuration simulation).`, enterMode("router-ospfv3", section), interfaceName);
  }
  if (lower[0] === "router" && lower[1] === "eigrp") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!parts[2]) return invalid("Usage: router eigrp AS-NUMBER|NAME", context, interfaceName);
    const section = `router eigrp ${parts[2]}`;
    rememberCommand(device, section, `router eigrp ${parts[2]}`);
    return success(`EIGRP process ${parts[2]} entered (configuration simulation).`, enterMode("router-eigrp", section), interfaceName);
  }
  if (lower[0] === "router" && lower[1] === "bgp") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!/^\d+$/.test(parts[2] ?? "")) return invalid("Usage: router bgp LOCAL-AS", context, interfaceName);
    const section = `router bgp ${parts[2]}`;
    rememberCommand(device, section, `router bgp ${parts[2]}`);
    return success(`BGP process AS ${parts[2]} entered (configuration simulation).`, enterMode("router-bgp", section), interfaceName);
  }
  if (lower[0] === "address-family" && ["router-ospfv3", "router-eigrp", "router-bgp"].includes(context.mode)) {
    if (!validFeatureCommand(context.mode, parts)) return invalid(`Unsupported address-family command: ${rawCommand}`, context, interfaceName);
    const section = `${context.target ?? "router"} ${parts.join(" ")}`;
    rememberCommand(device, section, parts.join(" "));
    return success(`Entered ${parts.join(" ")} (configuration simulation).`, enterMode("address-family", section), interfaceName);
  }
  if (lower[0] === "af-interface" && context.mode === "address-family" && parts[1]) {
    const section = `${context.target ?? "address-family"} af-interface ${parts[1]}`;
    rememberCommand(device, section, `af-interface ${parts[1]}`);
    return success(`Entered address-family interface ${parts[1]}.`, enterMode("af-interface", section), interfaceName);
  }
  if (lower[0] === "line") {
    const global = needGlobal();
    if (global !== true) return global;
    const line = parts.slice(1).join(" ");
    if (!/^console 0$|^vty 0 15$/i.test(line)) return invalid("Supported line contexts: line console 0, line vty 0 15.", context, interfaceName);
    const section = `line ${line}`;
    rememberCommand(device, section, section);
    return success(`Entered ${section} configuration.`, enterMode("line", section), interfaceName);
  }
  if (lower[0] === "wireless" && ["ssid", "password"].includes(lower[1] ?? "")) {
    const global = needGlobal();
    if (global !== true) return global;
    if (device.kind !== "wireless-router") return invalid("Configure wireless SSID and security on a wireless router.", context, interfaceName);
    if (lower[1] === "ssid") {
      const ssid = parts.slice(2).join(" ");
      if (!ssid || ssid.length > 32) return invalid("Usage: wireless ssid NAME (1–32 characters)", context, interfaceName);
      device.configuredCommands = device.configuredCommands.filter((entry) => entry.section !== "wireless" || !entry.command.startsWith("wireless ssid "));
      rememberCommand(device, "wireless", `wireless ssid ${ssid}`);
      return success(`Wireless SSID set to ${ssid}. Enable wlan0 before clients associate.`, context, interfaceName);
    }
    const password = parts.slice(2).join(" ");
    if (password.length < 8 || password.length > 63) return invalid("Wireless password must be 8–63 characters.", context, interfaceName);
    device.configuredCommands = device.configuredCommands.filter((entry) => entry.section !== "wireless" || !entry.command.startsWith("wireless password "));
    rememberCommand(device, "wireless", `wireless password ${password}`);
    return success("Wireless WPA2 passphrase configured.", context, interfaceName);
  }
  if (lower[0] === "ip" && lower[1] === "dhcp" && lower[2] === "pool") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!parts[3]) return invalid("Usage: ip dhcp pool POOL-NAME", context, interfaceName);
    const section = `ip dhcp pool ${parts[3]}`;
    rememberCommand(device, section, section);
    return success(`DHCP pool ${parts[3]} entered (configuration simulation).`, enterMode("dhcp-pool", section), interfaceName);
  }
  if (lower[0] === "ip" && lower[1] === "sla" && lower[2] !== "schedule") {
    const global = needGlobal();
    if (global !== true) return global;
    if (!/^\d+$/.test(parts[2] ?? "")) return invalid("Usage: ip sla ID", context, interfaceName);
    const section = `ip sla ${parts[2]}`;
    rememberCommand(device, section, section);
    return success(`IP SLA operation ${parts[2]} entered (configuration simulation).`, enterMode("ip-sla", section), interfaceName);
  }
  if (lower[0] === "ip" && lower[1] === "access-list" && ["standard", "extended"].includes(lower[2] ?? "")) {
    const global = needGlobal();
    if (global !== true) return global;
    if (!parts[3]) return invalid("Usage: ip access-list standard|extended ACL-NAME", context, interfaceName);
    const mode: CliMode = lower[2] === "standard" ? "acl-standard" : "acl-extended";
    const section = `ip access-list ${lower[2]} ${parts[3]}`;
    rememberCommand(device, section, section);
    return success(`Named ${lower[2]} ACL ${parts[3]} entered.`, enterMode(mode, section), interfaceName);
  }

  if (lower[0] === "network" && context.mode === "router-ospf") {
    if (!isValidIPv4(parts[1] ?? "") || !isValidIPv4(parts[2] ?? "") || lower[3] !== "area" || !/^\d+$/.test(parts[4] ?? "")) {
      return invalid("Usage: network NETWORK WILDCARD-MASK area AREA-ID", context, interfaceName);
    }
    const ospfNetwork: OspfNetwork = { network: parts[1], wildcard: parts[2], area: Number(parts[4]) };
    const isDuplicate = device.ospfNetworks.some((network) => network.network === ospfNetwork.network && network.wildcard === ospfNetwork.wildcard && network.area === ospfNetwork.area);
    if (!isDuplicate) device.ospfNetworks.push(ospfNetwork);
    return success(`OSPF network ${ospfNetwork.network} ${ospfNetwork.wildcard} area ${ospfNetwork.area} added.`, context, interfaceName);
  }

  if (lower[0] === "no" && lower[1] === "network" && context.mode === "router-ospf") {
    device.ospfNetworks = device.ospfNetworks.filter((network) => network.network !== parts[2] || network.wildcard !== parts[3]);
    return success("Matching OSPF network statement removed.", context, interfaceName);
  }

  if (lower[0] === "ip" && lower[1] === "sla" && lower[2] === "schedule" && context.mode === "global") {
    if (!/^\d+$/.test(parts[3] ?? "") || lower.slice(4).join(" ") !== "life forever start-time now") {
      return invalid("Usage: ip sla schedule ID life forever start-time now", context, interfaceName);
    }
    rememberCommand(device, "", parts.join(" "));
    return success(`IP SLA ${parts[3]} scheduled (configuration simulation).`, context, interfaceName);
  }

  if (lower[0] === "ipv6" && lower[1] === "route" && context.mode === "global") {
    if (parts.length < 4) return invalid("Usage: ipv6 route PREFIX NEXT-HOP-IPv6|EXIT-INTERFACE", context, interfaceName);
    if (!validIPv6Prefix(parts[2])) {
      return invalid("IPv6 route prefix must be a valid prefix such as ::/0.", context, interfaceName);
    }
    const exitInterface = device.interfaces.find((item) => normalizeInterfaceName(item.name) === normalizeInterfaceName(parts[3]));
    if (!validIPv6Address(parts[3]) && !exitInterface) {
      return invalid("Next hop must be an IPv6 address or existing exit interface.", context, interfaceName);
    }
    rememberCommand(device, "", validIPv6Address(parts[3]) ? parts.join(" ") : `ipv6 route ${parts[2]} ${exitInterface?.name}`);
    return success(`IPv6 route ${parts[2]} configured (route simulation).`, context, interfaceName);
  }

  if (lower[0] === "ip" && lower[1] === "route" && context.mode === "global") {
    const [network, mask, nextHop] = parts.slice(2);
    const exitInterface = device.interfaces.find((item) => normalizeInterfaceName(item.name) === normalizeInterfaceName(nextHop ?? ""));
    if (!network || !isValidIPv4(network) || !isValidSubnetMask(mask ?? "") || (!isValidIPv4(nextHop ?? "") && !exitInterface)) {
      return invalid("Usage: ip route NETWORK SUBNET-MASK NEXT-HOP-IP|EXIT-INTERFACE", context, interfaceName);
    }
    const route: StaticRoute = {
      network,
      mask,
      nextHop: isValidIPv4(nextHop) ? nextHop : "",
      exitInterface: isValidIPv4(nextHop) ? undefined : exitInterface?.name,
    };
    device.routes = device.routes.filter((item) => item.network !== network || item.mask !== mask);
    device.routes.push(route);
    return success(`Static route to ${network}/${prefixFromMask(mask)} installed.`, context, interfaceName);
  }

  if (lower[0] === "ip" && lower[1] === "address" && context.mode === "interface") {
    const networkInterface = currentInterface();
    if (!networkInterface) return invalid("Select a valid interface first.", context, interfaceName);
    if (!isValidIPv4(parts[2] ?? "") || !isValidSubnetMask(parts[3] ?? "")) return invalid("Usage: ip address IPv4 SUBNET-MASK", context, interfaceName);
    networkInterface.ip = parts[2];
    networkInterface.mask = parts[3];
    return success(`Address ${parts[2]} ${parts[3]} configured on ${networkInterface.name}.`, context, interfaceName);
  }

  if (lower[0] === "no" && lower[1] === "ip" && lower[2] === "address" && context.mode === "interface") {
    const networkInterface = currentInterface();
    if (!networkInterface) return invalid("Select a valid interface first.", context, interfaceName);
    networkInterface.ip = "";
    networkInterface.mask = "";
    return success(`IPv4 address removed from ${networkInterface.name}.`, context, interfaceName);
  }

  if (
    (lower[0] === "no" && (lower[1] === "shutdown" || lower[1] === "shut")) ||
    lower[0] === "shutdown" ||
    lower[0] === "shut"
  ) {
    if (context.mode !== "interface") return invalid("Select an interface before using shutdown or no shutdown.", context, interfaceName);
    const networkInterface = currentInterface();
    if (!networkInterface) return invalid("Select a valid interface first.", context, interfaceName);
    const interfaces = currentInterfaces();
    interfaces.forEach((item) => (item.enabled = lower[0] === "no"));
    return success(`${interfaces.map((item) => `${item.name} is ${item.enabled ? "up" : "administratively down"}`).join("\n")}.`, context, interfaceName);
  }

  if (lower.slice(0, 2).join(" ") === "switchport mode" && context.mode === "interface" && device.kind === "switch") {
    const mode = lower[2];
    if (mode !== "access" && mode !== "trunk") return invalid("Usage: switchport mode access|trunk", context, interfaceName);
    const interfaces = currentInterfaces();
    if (!interfaces.length) return invalid("Select a switch interface first.", context, interfaceName);
    interfaces.forEach((networkInterface) => {
      if (mode === "trunk" && networkInterface.allowedVlans.length === 1 && networkInterface.allowedVlans[0] === 1) {
        networkInterface.allowedVlans = [0];
      }
      networkInterface.mode = mode;
    });
    return success(`${interfaces.map((networkInterface) => `${networkInterface.name} configured as ${mode} mode`).join("\n")}.`, context, interfaceName);
  }

  if (lower.slice(0, 3).join(" ") === "switchport access vlan" && context.mode === "interface" && device.kind === "switch") {
    const vlanId = Number(parts[3]);
    if (!Number.isInteger(vlanId) || !isConfiguredVlan(device, vlanId)) return invalid(`VLAN ${parts[3]} does not exist. Create it with vlan ${parts[3]} first.`, context, interfaceName);
    const interfaces = currentInterfaces();
    if (!interfaces.length) return invalid("Select a switch interface first.", context, interfaceName);
    interfaces.forEach((networkInterface) => {
      networkInterface.accessVlan = vlanId;
      networkInterface.mode = "access";
    });
    return success(`${interfaces.map((networkInterface) => `${networkInterface.name} assigned to access VLAN ${vlanId}`).join("\n")}.`, context, interfaceName);
  }

  if (lower.slice(0, 3).join(" ") === "switchport trunk allowed" && context.mode === "interface" && device.kind === "switch") {
    const networkInterface = currentInterface();
    if (!networkInterface) return invalid("Select a switch interface first.", context, interfaceName);
    if (lower[3] !== "vlan" || !parts[4]) return invalid("Usage: switchport trunk allowed vlan VLAN-LIST|all|add VLAN-LIST|remove VLAN-LIST", context, interfaceName);
    const operation = ["add", "remove"].includes(lower[4]) ? lower[4] : "set";
    const vlanText = operation === "set" ? parts[4] : parts[5];
    const vlans = parseVlans(vlanText ?? "");
    if (!vlans || !vlans.length || vlans.some((vlanId) => vlanId !== 0 && (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094))) {
      return invalid("VLAN IDs must be between 1 and 4094. Allowed list example: 10,20 or 10-12.", context, interfaceName);
    }
    if (operation === "set") networkInterface.allowedVlans = vlans;
    else if (operation === "add") {
      networkInterface.allowedVlans = networkInterface.allowedVlans.includes(0) || vlans.includes(0)
        ? [0]
        : [...new Set([...networkInterface.allowedVlans, ...vlans])];
    } else if (networkInterface.allowedVlans.includes(0)) {
      networkInterface.allowedVlans = device.vlans.map((vlan) => vlan.id).filter((vlanId) => vlanId !== 1 && !vlans.includes(vlanId)).concat(vlans.includes(1) ? [] : [1]);
    } else {
      networkInterface.allowedVlans = networkInterface.allowedVlans.filter((vlanId) => !vlans.includes(vlanId));
    }
    networkInterface.mode = "trunk";
    return success(`Allowed VLANs on ${networkInterface.name}: ${networkInterface.allowedVlans.includes(0) ? "all" : networkInterface.allowedVlans.join(",") || "none"}.`, context, interfaceName);
  }

  if (lower[0] === "default" && lower[1] === "interface" && parts[2]) {
    const global = needGlobal();
    if (global !== true) return global;
    const networkInterface = device.interfaces.find((item) => item.name.toLowerCase() === parts[2].toLowerCase());
    if (!networkInterface) return invalid(`Interface ${parts[2]} does not exist.`, context, interfaceName);
    networkInterface.ip = "";
    networkInterface.mask = "";
    networkInterface.enabled = true;
    networkInterface.mode = "access";
    networkInterface.accessVlan = 1;
    networkInterface.allowedVlans = [1];
    return success(`${networkInterface.name} restored to defaults.`, context, interfaceName);
  }

  if (lower[0] === "ipv6" && lower[1] === "address" && context.mode === "interface") {
    if (!validIPv6Prefix(parts[2] ?? "")) {
      return invalid("Usage: ipv6 address IPv6-ADDRESS/PREFIX-LENGTH", context, interfaceName);
    }
    rememberCommand(device, `interface ${interfaceName}`, parts.join(" "));
    return success(`IPv6 address configured on ${interfaceName} (configuration simulation).`, context, interfaceName);
  }

  if (context.mode === "interface" && validFeatureCommand(context.mode, parts.slice(0, 1).concat(parts.slice(1)))) {
    const interfaces = currentInterfaces();
    if (!interfaces.length) return invalid("Select a valid interface first.", context, interfaceName);
    const command = parts.join(" ");
    interfaces.forEach((networkInterface) => rememberCommand(device, `interface ${networkInterface.name}`, command));
    return success(`${command} configured on ${interfaces.map((item) => item.name).join(", ")} (simulation).`, context, interfaceName);
  }

  if (
    context.mode !== "user" &&
    context.mode !== "privileged" &&
    context.mode !== "interface" &&
    context.mode !== "vlan" &&
    validFeatureCommand(context.mode, parts)
  ) {
    const section = context.target ?? context.mode;
    rememberCommand(device, section, parts.join(" "));
    if (lower[0] === "af-interface") {
      return success(`Entered ${parts.join(" ")}.`, enterMode("af-interface", `${section} ${parts.slice(1).join(" ")}`), interfaceName);
    }
    return success(`${parts.join(" ")} configured in ${section} (simulation).`, context, interfaceName);
  }

  if (context.mode === "global" && validFeatureCommand(context.mode, parts)) {
    rememberCommand(device, "", parts.join(" "));
    return success(`${parts.join(" ")} configured (simulation).`, context, interfaceName);
  }

  return invalid(`Invalid or unsupported command: "${rawCommand}". Type help for supported commands.`, context, interfaceName);
}
