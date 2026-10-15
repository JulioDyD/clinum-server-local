#include <cassert>
#include "../../../../call-cap-now-lora-esp32_c3/reliable_outbox.h"
#include "../../../../call-cap-now-lora-esp32_c3/lora_tx_scheduler.h"

int main() {
  Preferences::reset();
  ReliableOutbox queue;
  assert(queue.push({1, 100, 100, 1, 0}));
  assert(queue.push({1, 101, 0, 1, 3}));
  ReliableOutbox reboot; reboot.begin();
  assert(reboot.count == 1 && reboot.events[0].seq == 100 && reboot.localActive);
  assert(!reboot.acknowledge(99));
  Preferences::failWrites = true;
  assert(!reboot.acknowledge(100) && reboot.count == 1);
  assert(!reboot.push({3, 102, 100, 0, 0}) && reboot.localActive);
  assert(!reboot.closeFromServer(100) && reboot.localActive && reboot.count == 1);
  Preferences::failWrites = false;
  assert(reboot.acknowledge(100));
  assert(reboot.push({3, 102, 100, 0, 0}));
  ReliableOutbox secondBoot; secondBoot.begin();
  assert(!secondBoot.localActive && secondBoot.count == 1 && secondBoot.events[0].type == 3);
  assert(!secondBoot.closeFromServer(200));
  assert(secondBoot.closeFromServer(100));
  ReliableOutbox closedBoot; closedBoot.begin();
  assert(closedBoot.count == 0 && !closedBoot.localActive);
  Preferences::reset();
  ReliableOutbox capacity;
  for (int i = 0; i < 56; i++) assert(capacity.push({1, (uint32_t)i + 1, 0, 1, 3}));
  assert(!capacity.push({1, 57, 0, 1, 3}));
  for (int i = 0; i < 8; i++) assert(capacity.push({3, (uint32_t)i + 100, 100, 0, 0}));
  assert(!capacity.push({3, 999, 100, 0, 0}));
  Preferences::reset();
  ReliableOutbox stale;
  assert(stale.push({2, 200, 100, 2, 0}));
  assert(stale.push({3, 201, 100, 0, 0}));
  Preferences::failWrites = true;
  assert(!stale.rejectStale(200) && stale.count == 2);
  Preferences::failWrites = false;
  assert(stale.rejectStale(200) && stale.events[0].seq == 201 && stale.rejectedSeq == 200);

  HardwareSerial serial;
  LoraTxScheduler tx;
  assert(tx.enqueue(65535, "PAT,low"));
  assert(tx.enqueue(1, "ACK,critical"));
  tx.service(&serial);
  assert(serial.commands.size() == 1 && serial.commands[0].find("ACK,critical") != std::string::npos);
  assert(tx.enqueue(1, "CE,end"));
  tx.service(&serial); assert(serial.commands.size() == 1);
  assert(!tx.handleLine("+RCV=1,4,data,-90,10"));
  assert(tx.handleLine("+OK")); fakeMillis += 30; tx.service(&serial);
  assert(serial.commands.back().find("CE,end") != std::string::npos);
  assert(tx.handleLine("+ERR=17")); fakeMillis += 1000; tx.service(&serial);
  assert(serial.commands.back().find("CE,end") != std::string::npos && tx.moduleErrors == 1);
  fakeMillis += 6000; tx.service(&serial); assert(tx.timeouts == 1);
  puts("Firmware host tests passed: power cycle, special exclusion, NVS failures, capacity, AT priority/status/timeouts.");
}
