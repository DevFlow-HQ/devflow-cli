import assert from "node:assert/strict";
import { userInfo } from "node:os";
import test from "node:test";

import {
  readMacosKeychainCredential,
  type MacosKeychainCredentialExec,
} from "../../src/adapters/readMacosKeychainCredential.js";

test("macOS Keychain credential reader returns the credential blob from security", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const credential = '{"claudeAiOauth":{"accessToken":"secret"}}';
  const exec: MacosKeychainCredentialExec = async (file, args) => {
    calls.push({ file, args });
    return { stdout: credential };
  };

  const result = await readMacosKeychainCredential({ exec });

  assert.equal(result, credential);
  assert.deepEqual(calls, [
    {
      file: "security",
      args: [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        userInfo().username,
        "-w",
      ],
    },
  ]);
});

test("macOS Keychain credential reader returns null when security exits non-zero", async () => {
  const exec: MacosKeychainCredentialExec = async () => {
    throw Object.assign(new Error("not found"), { code: 44 });
  };

  assert.equal(await readMacosKeychainCredential({ exec }), null);
});

test("macOS Keychain credential reader surfaces unexpected execution errors", async () => {
  const failure = new Error("spawn failed before exit");
  const exec: MacosKeychainCredentialExec = async () => {
    throw failure;
  };

  await assert.rejects(
    readMacosKeychainCredential({ exec }),
    (error) => error === failure,
  );
});
