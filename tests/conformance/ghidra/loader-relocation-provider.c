typedef unsigned int rea_loader_word;

__attribute__((visibility("default")))
rea_loader_word rea_external(int value) {
  return (rea_loader_word)value + 3u;
}

__attribute__((visibility("default")))
rea_loader_word rea_external_value = 0x22222222u;

__attribute__((visibility("default")))
const rea_loader_word rea_external_const = 0x11111111u;
