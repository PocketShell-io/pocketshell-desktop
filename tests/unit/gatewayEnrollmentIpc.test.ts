import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/context';
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  registrations: [] as import('../../src/main/ssh/GatewayHosts').GatewayHostRegistration[],
  knownHosts: vi.fn(), connect: vi.fn(), token: vi.fn(), stream: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent/unit-profile' },
  ipcMain: { handle: (c: string, fn: (...args: unknown[]) => Promise<unknown>) => state.handlers.set(c, fn) } }));
vi.mock('../../src/main/ssh/GatewayHosts', () => ({ readGatewayHosts: () => state.registrations }));
vi.mock('../../src/main/ssh/GatewayStream', () => ({ openGatewayStream: (...args: unknown[]) => state.stream(...args) }));
vi.mock('../../src/main/ssh-config/SshConfigParser', () => ({ readSshConfig: () => [] }));
vi.mock('../../src/main/ssh-config/KnownHosts', () => ({ KnownHosts: class { constructor() { state.knownHosts(); } } }));
import { registerTerminalIpc } from '../../src/main/ipc/terminalIpc';
import { ipc } from '../../src/shared/channels';
import { transportRefusalMessage } from '@pocketshell/core';
const gateway = { serverUrl: 'wss://gateway.pocketshell.io', deviceId: 'unit-enrolled-device' };
const policy: import('../../src/main/helper/NativeWindowsHostCli').NativeWindowsHostCliPolicy = {
  executable: 'C:/Unit/pocketshell.exe', transport:'openssh-cmd-git-bash', deviceId:gateway.deviceId,
  trustedBashExecutable:'C:/Program Files/Git/bin/bash.exe', trustedBashSha256:'a'.repeat(64),
};
const pin = 'SHA256:' + 'a'.repeat(43);
const sock = {};
function invoke(payload: object): Promise<unknown> { return state.handlers.get(ipc.ssh.connect)!({}, { host:'display-only.invalid', user:'unit', ...payload }); }
beforeEach(() => {
  for (const mock of [state.knownHosts,state.connect,state.token,state.stream]) mock.mockReset();
  state.registrations = []; state.handlers.clear();
  state.connect.mockResolvedValue({ok:true,connectionId:'unit-connection'});
  state.token.mockResolvedValue('unit-public-fixture'); state.stream.mockResolvedValue(sock);
  registerTerminalIpc({ ssh: {connect:state.connect}, sync:{gatewayToken:state.token} } as unknown as IpcContext);
});
function enroll() {
  state.registrations = [{host:{ gateway } as import('@pocketshell/core').HostEntry, sshHostKeyFingerprint:pin, nativeWindowsCli:policy}];
}
describe('maintained gateway/native and shared refusal IPC coexist', () => {
  it('uses only main registration pin/native authority for an enrolled gateway, never renderer overrides', async () => {
    enroll();
    await expect(invoke({gateway, gatewayHostKeyFingerprint:'renderer', nativeWindowsCli:{executable:'renderer'}, nativeWindowsCliHostIdentity:'renderer'})).resolves.toEqual({ok:true,connectionId:'unit-connection'});
    expect(state.token).toHaveBeenCalledTimes(1);
    expect(state.stream).toHaveBeenCalledWith(gateway,'unit-public-fixture');
    expect(state.connect).toHaveBeenCalledWith(expect.objectContaining({sock,gatewayHostKeyFingerprint:pin,nativeWindowsCli:policy,nativeWindowsCliHostIdentity:gateway.deviceId}));
  });
  it.each([['undefined',undefined],['null',null],['malformed','bad']])('%s own-present gateway refuses before token/key/socket',async (_label,value) => {
    await expect(invoke({gateway:value})).resolves.toEqual({ok:false,error:transportRefusalMessage('gateway-invalid',null)});
    expect(state.token).not.toHaveBeenCalled();expect(state.stream).not.toHaveBeenCalled();expect(state.knownHosts).not.toHaveBeenCalled();expect(state.connect).not.toHaveBeenCalled();
  });
  it('conflicting link/gateway refuses even when enrolled',async () => {
    enroll();await expect(invoke({gateway,link:null})).resolves.toEqual({ok:false,error:transportRefusalMessage('link-and-gateway',null)});
    expect(state.token).not.toHaveBeenCalled();expect(state.connect).not.toHaveBeenCalled();
  });
  it('unregistered device and different origin refuse before broker use',async () => {
    enroll();
    for (const target of [{...gateway,deviceId:'unit-unknown'},{...gateway,serverUrl:'wss://other.example'}]) {
      await expect(invoke({gateway:target})).resolves.toEqual({ok:false,error:'Enroll this gateway host and its trusted SSH fingerprint on this Desktop first.'});
    }
    expect(state.token).not.toHaveBeenCalled();expect(state.knownHosts).not.toHaveBeenCalled();expect(state.connect).not.toHaveBeenCalled();
  });
  it('local-marked gateway refuses without token/socket fallback',async () => {
    enroll();await expect(invoke({gateway,local:true})).resolves.toEqual({ok:false,error:'Invalid gateway connection target.'});
    expect(state.token).not.toHaveBeenCalled();expect(state.connect).not.toHaveBeenCalled();
  });
  it('broker failure remains refusal rather than a plain SSH fallback',async () => {
    enroll();state.token.mockRejectedValueOnce(new Error('unit broker refused'));
    await expect(invoke({gateway})).resolves.toEqual({ok:false,error:'Gateway connection failed: unit broker refused'});
    expect(state.connect).not.toHaveBeenCalled();expect(state.knownHosts).not.toHaveBeenCalled();
  });
});
