#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <unistd.h>

static int load_secret(const char *filename) {
    struct stat status;
    if (lstat(filename, &status) != 0 || !S_ISREG(status.st_mode) || (status.st_mode & 0022)) return 20;
    int descriptor = open(filename, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (descriptor < 0) return 21;
    char secret[4096];
    ssize_t length = read(descriptor, secret, sizeof(secret) - 1);
    close(descriptor);
    if (length < 32 || length >= (ssize_t)sizeof(secret) - 1) return 22;
    while (length > 0 && (secret[length - 1] == '\n' || secret[length - 1] == '\r')) length--;
    secret[length] = '\0';
    if (setenv("CRONTAB_UI_AGENT_HMAC_SECRET", secret, 1) != 0) return 23;
    memset(secret, 0, sizeof(secret));
    if (unlink(filename) != 0) {
        unsetenv("CRONTAB_UI_AGENT_HMAC_SECRET");
        return 24;
    }
    return 0;
}

int main(int argc, char **argv) {
    int index = 1;
    if (argc > 3 && strcmp(argv[index], "--secret-file") == 0) {
        int result = load_secret(argv[index + 1]);
        if (result != 0) return result;
        index += 2;
    }
    if (argc <= index || argv[index][0] != '/') return 64;
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 25;
    execv(argv[index], &argv[index]);
    fprintf(stderr, "secure exec failed: %s\n", strerror(errno));
    return 70;
}
