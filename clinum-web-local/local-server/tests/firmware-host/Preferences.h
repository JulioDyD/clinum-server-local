#pragma once
#include <map>
#include <string>
#include <vector>
#include <cstring>
class Preferences {
  inline static std::map<std::string, std::vector<unsigned char>> storage;
  std::string name;
public:
  inline static bool failWrites = false;
  static void reset() { storage.clear(); failWrites = false; }
  bool begin(const char* ns, bool) { name = ns; return true; }
  void end() {}
  size_t getBytesLength(const char* key) { return storage[name + key].size(); }
  size_t getBytes(const char* key, void* out, size_t size) {
    auto& bytes = storage[name + key]; if (bytes.size() != size) return 0;
    memcpy(out, bytes.data(), size); return size;
  }
  size_t putBytes(const char* key, const void* data, size_t size) {
    if (failWrites) return 0;
    const auto* bytes = static_cast<const unsigned char*>(data);
    storage[name + key] = std::vector<unsigned char>(bytes, bytes + size); return size;
  }
};
