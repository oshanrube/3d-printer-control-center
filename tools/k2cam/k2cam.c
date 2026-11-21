/*
 * k2cam: camera service for the Creality K2 Plus.
 *
 * Subscribes to cam_app's H.264 stream over Creality's libdelivery pub/sub
 * (/tmp/delivery_socket100, topic 10000; see README.md), keeps the latest
 * keyframe (SPS+PPS+IDR) in memory and serves over HTTP:
 *   GET /keyframe            latest keyframe, raw Annex-B H.264 (nearly free)
 *   GET /?action=snapshot    JPEG, decoded on demand by the printer's ffmpeg
 *                            (nice 19, one at a time, cached per keyframe)
 *   GET /status              JSON
 * Nothing is decoded unless a snapshot is asked for.
 *
 * Snapshots use the SoC's video engine when it works (cedar_hw.c: hardware H.264 decode,
 * scale and JPEG, ~20 ms and ~15 ms CPU per frame): a worker thread then turns every
 * keyframe into a JPEG while snapshots are being asked for (60 s after the last one), so a
 * request is answered from memory. Otherwise (or after a hardware error) the printer's
 * ffmpeg decodes one keyframe per request, as before.
 *
 * Usage: k2cam [-p port=8080] [-s WxH=1280x720] [-i stationId=9001] [-q jpegQuality=80] [-n (no hardware)]
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>

#include "cedar_hw.c"

static void hw_feed(void);

#define DELIVERY_PATH "/tmp/delivery_socket100"
#define TOPIC_H264 10000
#define MAX_MSG (4u << 20)
#define MAX_CLIENTS 16
#define KF_FILE "/tmp/k2cam_kf.h264"
#define JPG_FILE "/tmp/k2cam_snap.jpg"
#define SNAP_TIMEOUT_MS 8000

static int port = 8080, station = 9001;
static char size[32] = "1280x720";
static int jpeg_quality = 80, use_hw = 1;

static int64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000; }

/* ---- delivery subscription ---- */
static int dfd = -1;
static int64_t d_retry_at = 0;
static uint8_t *msg; static uint32_t msg_have, msg_need; static uint32_t hdr[2]; static int hdr_have;
static uint8_t *kf; static uint32_t kf_len; static uint32_t kf_seq; static int64_t kf_at;
static uint64_t frames_total;

static void d_close(void) { if (dfd >= 0) close(dfd); dfd = -1; hdr_have = 0; msg_have = msg_need = 0; d_retry_at = now_ms() + 2000; }

static int write_all(int fd, const void *b, size_t n) {
  const char *p = b;
  while (n) { ssize_t w = write(fd, p, n); if (w < 0) { if (errno == EINTR) continue; return -1; } p += w; n -= w; }
  return 0;
}

static void d_connect(void) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX; strcpy(a.sun_path, DELIVERY_PATH);
  if (fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof a)) { if (fd >= 0) close(fd); d_retry_at = now_ms() + 2000; return; }
  uint32_t hello[3] = { 4, 0x10000, (uint32_t)station };
  uint32_t sub[4] = { 8, 0x10001, (uint32_t)station, TOPIC_H264 };
  if (write_all(fd, hello, sizeof hello) || write_all(fd, sub, sizeof sub)) { close(fd); d_retry_at = now_ms() + 2000; return; }
  fcntl(fd, F_SETFL, O_NONBLOCK);
  dfd = fd; hdr_have = 0; msg_have = msg_need = 0;
  fprintf(stderr, "k2cam: subscribed to station 100 topic %d as station %d\n", TOPIC_H264, station);
}

/* A keyframe message carries an SPS (NAL 7) near its start. */
static int is_keyframe(const uint8_t *p, uint32_t n) {
  for (uint32_t i = 0; i + 3 < n && i < 64; i++)
    if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 7) return 1;
  return 0;
}

static void d_message(uint32_t type, const uint8_t *p, uint32_t n) {
  if (type != TOPIC_H264) return;
  frames_total++;
  if (!is_keyframe(p, n)) return;
  uint8_t *c = realloc(kf, n); if (!c) return;
  kf = c; memcpy(kf, p, n); kf_len = n; kf_seq++; kf_at = now_ms();
  hw_feed();
}

static void d_read(void) {
  for (;;) {
    if (hdr_have < 8) {
      ssize_t r = read(dfd, (char *)hdr + hdr_have, 8 - hdr_have);
      if (r == 0) { fprintf(stderr, "k2cam: delivery closed\n"); d_close(); return; }
      if (r < 0) { if (errno == EAGAIN || errno == EINTR) return; d_close(); return; }
      hdr_have += r; if (hdr_have < 8) return;
      if (hdr[0] > MAX_MSG) { fprintf(stderr, "k2cam: bad length %u\n", hdr[0]); d_close(); return; }
      msg_need = hdr[0]; msg_have = 0;
    }
    if (msg_have < msg_need) {
      ssize_t r = read(dfd, msg + msg_have, msg_need - msg_have);
      if (r == 0) { d_close(); return; }
      if (r < 0) { if (errno == EAGAIN || errno == EINTR) return; d_close(); return; }
      msg_have += r; if (msg_have < msg_need) return;
    }
    d_message(hdr[1], msg, msg_need);
    hdr_have = 0;
  }
}

/* ---- snapshot (on-demand decode) ---- */
static pid_t snap_pid = 0; static int64_t snap_started; static uint32_t snap_seq;
static uint8_t *jpg; static uint32_t jpg_len, jpg_seq; static int64_t jpg_at;
static uint64_t snaps_made;

/* ---- hardware pipeline (worker thread) ---- */
static int hw_ok;                         /* hardware opened and not failed */
static int64_t hw_active_until;          /* feed keyframes until then (extended by snapshot requests) */
static pthread_mutex_t hw_mu = PTHREAD_MUTEX_INITIALIZER; static pthread_cond_t hw_cv = PTHREAD_COND_INITIALIZER;
static uint8_t *hw_in; static uint32_t hw_in_len, hw_in_seq; static int hw_in_ready;   /* keyframe for the worker */
static uint8_t *hw_out; static uint32_t hw_out_len, hw_out_seq; static int hw_out_ready, hw_failed; /* JPEG from the worker */
static uint64_t hw_jpegs;

static void *hw_worker(void *arg) {
  (void)arg;
  for (;;) {
    pthread_mutex_lock(&hw_mu);
    while (!hw_in_ready) pthread_cond_wait(&hw_cv, &hw_mu);
    uint8_t *in = hw_in; uint32_t len = hw_in_len, seq = hw_in_seq; hw_in = NULL; hw_in_ready = 0;
    pthread_mutex_unlock(&hw_mu);
    unsigned char *out = NULL; int olen = 0;
    int r = hw_jpeg((const char *)in, len, &out, &olen);
    free(in);
    pthread_mutex_lock(&hw_mu);
    if (r == 1) { free(hw_out); hw_out = out; hw_out_len = olen; hw_out_seq = seq; hw_out_ready = 1; }
    else if (r < 0) { hw_failed = 1; free(out); }
    pthread_mutex_unlock(&hw_mu);
    if (r < 0) { fprintf(stderr, "k2cam: hardware pipeline failed (%d), using ffmpeg from now on\n", r); return NULL; }
  }
}

/* Main loop: hand the newest keyframe to the worker (dropping one it hasn't started). */
static void hw_feed(void) {
  if (!hw_ok || now_ms() > hw_active_until) return;
  uint8_t *c = malloc(kf_len); if (!c) return;
  memcpy(c, kf, kf_len);
  pthread_mutex_lock(&hw_mu);
  free(hw_in); hw_in = c; hw_in_len = kf_len; hw_in_seq = kf_seq; hw_in_ready = 1;
  pthread_cond_signal(&hw_cv);
  pthread_mutex_unlock(&hw_mu);
}


static void snap_start(void) {
  int f = open(KF_FILE, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (f < 0) return;
  if (write_all(f, kf, kf_len)) { close(f); return; }
  close(f);
  unlink(JPG_FILE);
  pid_t pid = fork();
  if (pid == 0) {
    char vf[64]; snprintf(vf, sizeof vf, "scale=%s", size);
    for (char *x = vf; *x; x++) if (*x == 'x') *x = ':';
    int nul = open("/dev/null", O_RDWR); dup2(nul, 0); dup2(nul, 1);
    execlp("nice", "nice", "-n", "19", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
           "-f", "h264", "-i", KF_FILE, "-vf", vf, "-frames:v", "1", "-q:v", "5", JPG_FILE, (char *)NULL);
    _exit(127);
  }
  if (pid > 0) { snap_pid = pid; snap_started = now_ms(); snap_seq = kf_seq; }
}

static void snap_reap(void) {
  if (!snap_pid) return;
  int st; pid_t r = waitpid(snap_pid, &st, WNOHANG);
  if (r == 0) {
    if (now_ms() - snap_started > SNAP_TIMEOUT_MS) { kill(snap_pid, SIGKILL); waitpid(snap_pid, &st, 0); snap_pid = 0; }
    return;
  }
  snap_pid = 0;
  if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) return;
  int f = open(JPG_FILE, O_RDONLY); if (f < 0) return;
  struct stat sb; if (fstat(f, &sb) || sb.st_size < 100 || sb.st_size > (8 << 20)) { close(f); return; }
  uint8_t *b = malloc(sb.st_size);
  if (b && read(f, b, sb.st_size) == sb.st_size) { free(jpg); jpg = b; jpg_len = sb.st_size; jpg_seq = snap_seq; jpg_at = now_ms(); snaps_made++; }
  else free(b);
  close(f);
}

/* ---- HTTP ---- */
enum { C_FREE, C_READING, C_WAIT_SNAP };
struct client { int fd; int state; char req[2048]; int len; int64_t since; };
static struct client cl[MAX_CLIENTS];
static int lfd = -1;

static void c_close(struct client *c) { if (c->fd >= 0) close(c->fd); c->fd = -1; c->state = C_FREE; }

static void c_send(struct client *c, int code, const char *ctype, const void *body, uint32_t n, const char *extra) {
  char h[512];
  int hl = snprintf(h, sizeof h, "HTTP/1.0 %d %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\n%sConnection: close\r\n\r\n",
                    code, code == 200 ? "OK" : code == 404 ? "Not Found" : "Service Unavailable", ctype, n, extra ? extra : "");
  int fl = fcntl(c->fd, F_GETFL); fcntl(c->fd, F_SETFL, fl & ~O_NONBLOCK);   /* LAN client: send in one go, bounded by SO_SNDTIMEO */
  if (!write_all(c->fd, h, hl) && n) write_all(c->fd, body, n);
  c_close(c);
}

static int64_t kf_age(void) { return kf_len ? now_ms() - kf_at : -1; }

static void c_snapshot_ready(struct client *c) {
  char ex[128]; snprintf(ex, sizeof ex, "X-Seq: %u\r\nX-Age-Ms: %lld\r\nX-Encoder: %s\r\n", jpg_seq, (long long)(now_ms() - jpg_at), hw_ok ? "hw" : "ffmpeg");
  c_send(c, 200, "image/jpeg", jpg, jpg_len, ex);
}

static void c_handle(struct client *c) {
  char path[256] = "/";
  sscanf(c->req, "%*s %255s", path);
  int64_t age = kf_age();
  if (!strncmp(path, "/status", 7)) {
    char b[512];
    int n = snprintf(b, sizeof b, "{\"subscribed\":%s,\"keyframe_seq\":%u,\"keyframe_bytes\":%u,\"keyframe_age_ms\":%lld,\"frames_total\":%llu,\"snapshots_made\":%llu,\"size\":\"%s\",\"hw\":%s,\"hw_active\":%s,\"hw_jpegs\":%llu}\n",
                     dfd >= 0 ? "true" : "false", kf_seq, kf_len, (long long)age, (unsigned long long)frames_total, (unsigned long long)snaps_made, size,
                     hw_ok ? "true" : "false", hw_ok && now_ms() <= hw_active_until ? "true" : "false", (unsigned long long)hw_jpegs);
    c_send(c, 200, "application/json", b, n, NULL);
  } else if (!strncmp(path, "/keyframe", 9)) {
    if (!kf_len || age > 5000) { c_send(c, 503, "text/plain", "no recent keyframe\n", 19, NULL); return; }
    char ex[96]; snprintf(ex, sizeof ex, "X-Seq: %u\r\nX-Age-Ms: %lld\r\n", kf_seq, (long long)age);
    c_send(c, 200, "video/h264", kf, kf_len, ex);
  } else if (strstr(path, "action=snapshot") || !strncmp(path, "/snapshot", 9)) {
    if (!kf_len || age > 5000) { c_send(c, 503, "text/plain", "no recent keyframe\n", 19, NULL); return; }
    if (hw_ok) {
      int was_active = now_ms() <= hw_active_until;
      hw_active_until = now_ms() + 60000;
      if (!was_active) hw_feed();                 /* wake the pipeline with the current keyframe */
      if (jpg_len && now_ms() - jpg_at < 2500) { c_snapshot_ready(c); return; }   /* fresh hardware JPEG */
      c->state = C_WAIT_SNAP; c->since = now_ms(); return;                         /* the next one is ~1 s away */
    }
    if (jpg_len && jpg_seq == kf_seq) { c_snapshot_ready(c); return; }   /* already decoded this keyframe */
    if (!snap_pid) snap_start();
    if (!snap_pid) { c_send(c, 503, "text/plain", "decode failed to start\n", 23, NULL); return; }
    c->state = C_WAIT_SNAP; c->since = now_ms();
  } else {
    c_send(c, 404, "text/plain", "k2cam: /keyframe /?action=snapshot /status\n", 44, NULL);
  }
}

static void c_accept(void) {
  int fd = accept(lfd, NULL, NULL); if (fd < 0) return;
  int i; for (i = 0; i < MAX_CLIENTS && cl[i].state != C_FREE; i++);
  if (i == MAX_CLIENTS) { close(fd); return; }
  struct timeval tv = { 3, 0 }; setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  fcntl(fd, F_SETFL, O_NONBLOCK);
  cl[i].fd = fd; cl[i].state = C_READING; cl[i].len = 0; cl[i].since = now_ms();
}

static void c_read(struct client *c) {
  ssize_t r = read(c->fd, c->req + c->len, sizeof c->req - 1 - c->len);
  if (r <= 0) { if (r < 0 && (errno == EAGAIN || errno == EINTR)) return; c_close(c); return; }
  c->len += r; c->req[c->len] = 0;
  if (strstr(c->req, "\r\n\r\n") || strstr(c->req, "\n\n") || c->len >= (int)sizeof c->req - 1) c_handle(c);
}

/* Main loop: take a finished JPEG from the worker. */
static void hw_collect(void) {
  if (!hw_ok) return;
  pthread_mutex_lock(&hw_mu);
  if (hw_out_ready) { free(jpg); jpg = hw_out; jpg_len = hw_out_len; jpg_seq = hw_out_seq; jpg_at = now_ms(); hw_out = NULL; hw_out_ready = 0; hw_jpegs++; snaps_made++; }
  int failed_now = hw_failed && hw_ok;
  if (hw_failed) hw_ok = 0;
  pthread_mutex_unlock(&hw_mu);
  if (failed_now && kf_len && !snap_pid) { snap_start(); for (int i = 0; i < MAX_CLIENTS; i++) if (cl[i].state == C_WAIT_SNAP) cl[i].since = now_ms(); }
}

int main(int argc, char **argv) {
  int o;
  while ((o = getopt(argc, argv, "p:s:i:q:n")) != -1) {
    if (o == 'p') port = atoi(optarg);
    else if (o == 's') snprintf(size, sizeof size, "%s", optarg);
    else if (o == 'i') station = atoi(optarg);
    else if (o == 'q') jpeg_quality = atoi(optarg);
    else if (o == 'n') use_hw = 0;
  }
  signal(SIGPIPE, SIG_IGN);
  msg = malloc(MAX_MSG);
  for (int i = 0; i < MAX_CLIENTS; i++) { cl[i].fd = -1; cl[i].state = C_FREE; }
  lfd = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1; setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a; memset(&a, 0, sizeof a); a.sin_family = AF_INET; a.sin_port = htons(port); a.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(lfd, (struct sockaddr *)&a, sizeof a) || listen(lfd, 16)) { perror("k2cam: listen"); return 1; }
  fcntl(lfd, F_SETFL, O_NONBLOCK);
  if (use_hw) {
    int w = 1280, h = 720; sscanf(size, "%dx%d", &w, &h);
    pthread_t th;
    if (hw_open(w, h, jpeg_quality) == 0 && pthread_create(&th, NULL, hw_worker, NULL) == 0) { hw_ok = 1; pthread_detach(th); }
    else fprintf(stderr, "k2cam: hardware video engine unavailable, using ffmpeg for snapshots\n");
  }
  fprintf(stderr, "k2cam: listening on :%d, snapshot size %s, encoder %s\n", port, size, hw_ok ? "hardware" : "ffmpeg");

  for (;;) {
    if (dfd < 0 && now_ms() >= d_retry_at) d_connect();
    struct pollfd p[2 + MAX_CLIENTS]; struct client *pc[2 + MAX_CLIENTS]; int n = 0;
    p[n].fd = lfd; p[n].events = POLLIN; pc[n++] = NULL;
    int dpi = -1; if (dfd >= 0) { dpi = n; p[n].fd = dfd; p[n].events = POLLIN; pc[n++] = NULL; }
    for (int i = 0; i < MAX_CLIENTS; i++) if (cl[i].state == C_READING) { p[n].fd = cl[i].fd; p[n].events = POLLIN; pc[n++] = &cl[i]; }
    poll(p, n, 100);
    if (p[0].revents & POLLIN) c_accept();
    if (dpi >= 0 && p[dpi].revents) d_read();
    for (int i = 0; i < n; i++) if (pc[i] && p[i].revents) c_read(pc[i]);
    snap_reap();
    hw_collect();
    int64_t t = now_ms();
    for (int i = 0; i < MAX_CLIENTS; i++) {
      struct client *c = &cl[i];
      if (c->state == C_READING && t - c->since > 5000) c_close(c);
      else if (c->state == C_WAIT_SNAP && hw_ok) {
        if (jpg_len && jpg_at > c->since) c_snapshot_ready(c);
        else if (t - c->since > 4000) {
          if (jpg_len && t - jpg_at < 10000) c_snapshot_ready(c);
          else c_send(c, 503, "text/plain", "decode timeout\n", 15, NULL);
        }
      }
      else if (c->state == C_WAIT_SNAP) {
        if (jpg_len && jpg_seq == snap_seq && !snap_pid) c_snapshot_ready(c);
        else if (!snap_pid && t - c->since > 200) {
          /* decode finished without a picture (or a newer keyframe raced it): serve the last good one or fail */
          if (jpg_len && t - jpg_at < 10000) c_snapshot_ready(c);
          else c_send(c, 503, "text/plain", "decode failed\n", 14, NULL);
        } else if (t - c->since > SNAP_TIMEOUT_MS) c_send(c, 503, "text/plain", "decode timeout\n", 15, NULL);
      }
    }
  }
}
