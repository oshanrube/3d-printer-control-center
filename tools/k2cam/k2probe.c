/* Probe Creality libdelivery: subscribe to cam_app (station 100) topic 10000, log messages. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <sys/socket.h>
#include <sys/un.h>
static int rd(int fd, void *b, size_t n) { size_t g = 0; while (g < n) { ssize_t r = read(fd, (char*)b + g, n - g); if (r <= 0) return -1; g += r; } return 0; }
static void msg(int fd, uint32_t type, const uint32_t *p, uint32_t n) { uint32_t h[2] = { n * 4, type }; write(fd, h, 8); write(fd, p, n * 4); }
int main(int argc, char **argv) {
  uint32_t me = argc > 1 ? atoi(argv[1]) : 901, topic = argc > 2 ? atoi(argv[2]) : 10000; int secs = argc > 3 ? atoi(argv[3]) : 8;
  const char *out = argc > 4 ? argv[4] : NULL; FILE *f = out ? fopen(out, "wb") : NULL; long saved = 0;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0); struct sockaddr_un a = { .sun_family = AF_UNIX }; strcpy(a.sun_path, "/tmp/delivery_socket100");
  if (connect(fd, (struct sockaddr*)&a, sizeof a)) { perror("connect"); return 1; }
  uint32_t hello[1] = { me }, sub[2] = { me, topic };
  msg(fd, 0x10000, hello, 1); msg(fd, 0x10001, sub, 2);
  time_t end = time(NULL) + secs; int n = 0; static unsigned char buf[4 << 20];
  while (time(NULL) < end) {
    uint32_t h[2]; if (rd(fd, h, 8)) { puts("closed"); break; }
    if (h[0] > sizeof buf) { printf("len %u too big\n", h[0]); break; }
    if (rd(fd, buf, h[0])) { puts("closed"); break; }
    if (n < 40 || n % 25 == 0) { printf("#%d type=%u len=%u :", n, h[1], h[0]); for (unsigned i = 0; i < 24 && i < h[0]; i++) printf(" %02x", buf[i]); printf("\n"); }
    if (f && saved + h[0] < (3 << 20)) { fwrite(buf, 1, h[0], f); saved += h[0]; }
    n++;
  }
  printf("messages=%d saved=%ld\n", n, saved); if (f) fclose(f); close(fd); return 0;
}
