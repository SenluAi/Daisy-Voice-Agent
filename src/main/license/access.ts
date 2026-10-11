let checkAccess: () => boolean = () => true;
let operations = new AbortController();

// Installed by the main process before any runtime or plugin is started.
export function setLicenseAccessCheck(check: () => boolean): void { checkAccess = check; }
export function isLicenseAccessAllowed(): boolean { return checkAccess(); }
export function licenseOperationSignal(): AbortSignal { return operations.signal; }
export function stopLicensedOperations(): void { operations.abort(new Error("Daisy 授权已锁定，操作已取消")); }
export function resumeLicensedOperations(): void { if (operations.signal.aborted) operations = new AbortController(); }
export function requireLicenseAccess(): void {
  if (!isLicenseAccessAllowed()) throw new Error("Daisy 试用已到期或授权需要核验，请在授权激活界面激活后使用。");
}
