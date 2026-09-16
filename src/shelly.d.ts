// Ambient declarations for the Shelly Gen2 script environment (fw 2.0.0).
// The device runtime provides these globals; the test mock emulates them.

declare function print(msg: string): void;

interface ShellySwitchStatus {
  output: boolean;
}

interface ShellyInputStatus {
  state: boolean;
}

interface ShellySwitchConfig {
  initial_state: string;
  in_mode: string;
  auto_off: boolean;
  auto_off_delay: number;
}

interface ShellyInputConfig {
  enable: boolean;
}

type RpcCallback = (
  result: unknown,
  errorCode: number,
  errorMessage: string,
  userdata: unknown,
) => void;

declare const Shelly: {
  call(method: string, params: object, cb?: RpcCallback, userdata?: unknown): void;
  getComponentStatus(key: string): ShellySwitchStatus & ShellyInputStatus | null;
  getComponentConfig(key: string): (ShellySwitchConfig & ShellyInputConfig) | null;
  addEventHandler(cb: (ev: ShellyEvent) => void): void;
  addStatusHandler(cb: (st: ShellyStatus) => void): void;
};

interface ShellyEvent {
  component: string;
  info?: { event: string; state?: boolean; id: number; };
}

interface ShellyStatus {
  name: string;
  id: number;
  component: string;
  delta?: { output?: boolean; source?: string; };
}

declare const Timer: {
  set(ms: number, repeat: boolean, cb: () => void): number;
  clear(handle: number): void;
};

interface HttpRequest {
  query?: string;
}

interface HttpResponse {
  code: number;
  body: string;
  send(): void;
}

declare const HTTPServer: {
  registerEndpoint(name: string, cb: (req: HttpRequest, res: HttpResponse) => void): void;
};
