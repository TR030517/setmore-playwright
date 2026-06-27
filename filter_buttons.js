const buttons = require('./buttons-inspect.json');

for (const item of buttons.filter((button) => button.visible && button.rect && button.rect.x > 1400 && button.rect.y < 260)) {
  console.log(JSON.stringify({
    text: item.text,
    aria: item.aria,
    tag: item.tag,
    rect: item.rect,
    className: String(item.className).slice(0, 160),
  }));
}