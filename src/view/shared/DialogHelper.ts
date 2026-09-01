/** 封装 Renderer 通用确认、提示和输入对话框。 */
/**
 * DialogHelper —— 通用对话框工具类。
 * 封装通用对话框和页面顶部的非阻塞提示。
 */

let noticeTimer: number | null = null;

function showNotice(message: string, warning: boolean): void {
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
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'save-success-notice-text';
    notice.append(icon, text);
    document.body.append(notice);
  }

  const icon = notice.querySelector<HTMLElement>('.save-success-notice-icon');
  if (icon) icon.textContent = warning ? '!' : '✓';
  const text = notice.querySelector<HTMLElement>('.save-success-notice-text');
  if (text) text.textContent = message;
  notice.classList.toggle('is-warning', warning);
  notice.classList.add('is-visible');
  notice.setAttribute('aria-hidden', 'false');

  if (noticeTimer !== null) {
    window.clearTimeout(noticeTimer);
  }
  noticeTimer = window.setTimeout(() => {
    notice?.classList.remove('is-visible');
    notice?.setAttribute('aria-hidden', 'true');
    noticeTimer = null;
  }, 2400);
}

/** 仅在数据确认写入成功后调用。 */
export function showSaveSuccess(message = '保存成功'): void {
  showNotice(message, false);
}

/** 显示不阻塞当前操作的警告提示。 */
export function showWarningNotice(message: string): void {
  showNotice(message, true);
}

/** Escape 只关闭当前顶层通用对话框，不继续传递到底层浮窗。 */
function closeDialogOnEscape(
  event: KeyboardEvent,
  close: () => void,
): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  close();
}

/** 弹出输入框，返回用户输入的字符串，取消返回 null */
export function showPrompt(
  title: string,
  message = '',
  defaultValue = '',
): Promise<string | null> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleEl = document.getElementById('generic-prompt-title')!;
  const msgEl = document.getElementById('generic-prompt-message')!;
  const inputEl = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const okBtn = document.getElementById('generic-prompt-ok')!;
  const cancelBtn = document.getElementById('generic-prompt-cancel')!;

  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.style.display = message ? '' : 'none';
  inputEl.style.display = '';
  inputEl.value = defaultValue;
  cancelBtn.style.display = '';
  overlay.style.display = '';
  inputEl.focus();
  inputEl.select();

  return new Promise<string | null>((resolve) => {
    const cleanup = () => {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
    };
    const onOk = () => {
      cleanup();
      resolve(inputEl.value);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && event.target === inputEl) {
        onOk();
        return;
      }
      closeDialogOnEscape(event, onCancel);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
  });
}

/** 弹出确认框，返回 true/false */
export function showConfirm(title: string, message = ''): Promise<boolean> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleEl = document.getElementById('generic-prompt-title')!;
  const msgEl = document.getElementById('generic-prompt-message')!;
  const inputEl = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const okBtn = document.getElementById('generic-prompt-ok')!;
  const cancelBtn = document.getElementById('generic-prompt-cancel')!;

  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.style.display = message ? '' : 'none';
  inputEl.style.display = 'none';
  cancelBtn.style.display = '';
  overlay.style.display = '';
  okBtn.focus();

  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('keydown', onKey);
    };
    const onOk = () => {
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onKey = (event: KeyboardEvent) => {
      closeDialogOnEscape(event, onCancel);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('keydown', onKey);
  });
}

/** 弹出提示框（只有确定按钮） */
export function showAlert(title: string, message = ''): Promise<void> {
  const overlay = document.getElementById('generic-prompt')!;
  const titleEl = document.getElementById('generic-prompt-title')!;
  const msgEl = document.getElementById('generic-prompt-message')!;
  const inputEl = document.getElementById(
    'generic-prompt-input',
  ) as HTMLInputElement;
  const okBtn = document.getElementById('generic-prompt-ok')!;
  const cancelBtn = document.getElementById('generic-prompt-cancel')!;

  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.style.display = message ? '' : 'none';
  inputEl.style.display = 'none';
  cancelBtn.style.display = 'none';
  overlay.style.display = '';
  okBtn.focus();

  return new Promise<void>((resolve) => {
    const cleanup = () => {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('keydown', onKey);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onKey = (event: KeyboardEvent) => {
      closeDialogOnEscape(event, onOk);
    };
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('keydown', onKey);
  });
}
