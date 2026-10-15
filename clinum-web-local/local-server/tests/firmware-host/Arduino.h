#pragma once
#ifdef _MSC_VER
#define __attribute__(x)
#endif
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
inline uint32_t fakeMillis = 0;
inline uint32_t millis() { return fakeMillis; }
inline long random(long min, long) { return min; }
struct HardwareSerial { std::vector<std::string> commands; void print(const char* text) { commands.emplace_back(text); } };
