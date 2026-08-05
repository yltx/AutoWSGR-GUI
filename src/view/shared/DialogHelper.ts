/** Renderer 通用确认、提示、输入对话框和保存通知。 */
let saveSuccessTimer: number | null = null;

/** 仅在数据确认写入成功后调用。 */
export function showSaveSuccess(message = '保存成功'): void {
  let notice = document.getElementById('save-success-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'save-success-notice';
    notice.className = 'save-success-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('aria-hidden', 'true');

    const icon = document.createElement('span');
    icon.className = 'save-success-notice-icon';
    icon.textContent = '✓';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'save-success-notice-text';
    notice.append(icon, text);
    document.body.append(notice);
  }

  const text = notice.querySelector<HTMLElement>(
    '.save-success-notice-text',
  );
  if (text) text.textContent = message;
  notice.classList.add('is-visible');
  notice.setAttribute('aria-hidden', 'false');

  if (saveSuccessTimer !== null) {
    window.clearTimeout(saveSuccessTimer);
  }
  saveSuccessTimer = window.setTimeout(() => {
    notice?.classList.remove('is-visible');
    notice?.setAttribute('aria-hidden', 'true');
    saveSuccessTimer = null;
  }, 2400);
}

/** 弹出输入框，取消时返回 null。 */
export function showPrompt(
  title: string,
  message = '',
  defaultValue = '',
): Promise<string | null> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleElement = document.getElementById('generic-prompt-title')!;
  const messageElement = document.getElementById(
    'generic-prompt-message',
  )!;
  const input = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const confirmButton = document.getElementById('generic-prompt-ok')!;
  const cancelButton = document.getElementById('generic-prompt-cancel')!;

  titleElement.textContent = title;
  messageElement.textContent = message;
  messageElement.style.display = message ? '' : 'none';
  input.style.display = '';
  input.value = defaultValue;
  cancelButton.style.display = '';
  overlay.style.display = '';
  input.focus();
  input.select();

  return new Promise<string | null>(resolve => {
    const cleanup = () => {
      overlay.style.display = 'none';
      confirmButton.removeEventListener('click', confirm);
      cancelButton.removeEventListener('click', cancel);
      input.removeEventListener('keydown', handleKey);
    };
    const confirm = () => {
      cleanup();
      resolve(input.value);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') confirm();
      if (event.key === 'Escape') cancel();
    };
    confirmButton.addEventListener('click', confirm);
    cancelButton.addEventListener('click', cancel);
    input.addEventListener('keydown', handleKey);
  });
}

/** 弹出确认框。 */
export function showConfirm(
  title: string,
  message = '',
): Promise<boolean> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleElement = document.getElementById('generic-prompt-title')!;
  const messageElement = document.getElementById(
    'generic-prompt-message',
  )!;
  const input = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const confirmButton = document.getElementById('generic-prompt-ok')!;
  const cancelButton = document.getElementById('generic-prompt-cancel')!;

  titleElement.textContent = title;
  messageElement.textContent = message;
  messageElement.style.display = message ? '' : 'none';
  input.style.display = 'none';
  cancelButton.style.display = '';
  overlay.style.display = '';
  confirmButton.focus();

  return new Promise<boolean>(resolve => {
    const cleanup = () => {
      overlay.style.display = 'none';
      confirmButton.removeEventListener('click', confirm);
      cancelButton.removeEventListener('click', cancel);
    };
    const confirm = () => {
      cleanup();
      resolve(true);
    };
    const cancel = () => {
      cleanup();
      resolve(false);
    };
    confirmButton.addEventListener('click', confirm);
    cancelButton.addEventListener('click', cancel);
  });
}

/** 弹出只有确定按钮的提示框。 */
export function showAlert(
  title: string,
  message = '',
): Promise<void> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleElement = document.getElementById('generic-prompt-title')!;
  const messageElement = document.getElementById(
    'generic-prompt-message',
  )!;
  const input = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const confirmButton = document.getElementById('generic-prompt-ok')!;
  const cancelButton = document.getElementById('generic-prompt-cancel')!;

  titleElement.textContent = title;
  messageElement.textContent = message;
  messageElement.style.display = message ? '' : 'none';
  input.style.display = 'none';
  cancelButton.style.display = 'none';
  overlay.style.display = '';
  confirmButton.focus();

  return new Promise<void>(resolve => {
    const cleanup = () => {
      overlay.style.display = 'none';
      confirmButton.removeEventListener('click', confirm);
    };
    const confirm = () => {
      cleanup();
      resolve();
    };
    confirmButton.addEventListener('click', confirm);
  });
}
