/** 按选项文案为设置页下拉框选择受控的分级宽度。 */
export function updateSettingSelectWidth(select: HTMLSelectElement): void {
  const fixedWidth = Number(select.dataset['configSelectWidth']);
  if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
    select.style.setProperty('--config-select-width', `${fixedWidth}px`);
    return;
  }

  const context = document.createElement('canvas').getContext('2d');
  if (!context) return;

  context.font = window.getComputedStyle(select).font;
  const contentWidth = Math.max(
    0,
    ...Array.from(
      select.options,
      option => context.measureText(option.text.trim()).width,
    ),
  );
  const requiredWidth = Math.ceil(contentWidth + 38);
  const widthSteps = [96, 124, 168, 204, 240, 280, 320];
  const width = widthSteps.find(step => step >= requiredWidth)
    ?? widthSteps[widthSteps.length - 1]!;
  select.style.setProperty('--config-select-width', `${width}px`);
}
