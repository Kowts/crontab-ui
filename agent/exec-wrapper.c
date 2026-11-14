#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

extern char **environ;

static int valid_name(const char *value) {
    if (!value || !*value) return 0;
    for (const char *cursor = value; *cursor; cursor++) {
        if (!( (*cursor >= 'a' && *cursor <= 'z') || (*cursor >= 'A' && *cursor <= 'Z')
            || (*cursor >= '0' && *cursor <= '9') || *cursor == '-' )) return 0;
    }
    return 1;
}

int main(int argc, char **argv) {
    if (argc < 4 || !valid_name(argv[1]) || argv[2][0] != '/' || argv[3][0] != '/') return 64;
    const char *root = getenv("CRONTAB_UI_AGENT_CGROUP_ROOT");
    if (!root || strncmp(root, "/sys/fs/cgroup/", 15) != 0 || strstr(root, "/../") || strstr(root, "\n")) return 65;

    char membership[PATH_MAX];
    int length = snprintf(membership, sizeof(membership), "%s/%s/cgroup.procs", root, argv[1]);
    if (length < 0 || (size_t)length >= sizeof(membership)) return 66;

    FILE *cgroup = fopen(membership, "w");
    if (!cgroup) return 67;
    if (fprintf(cgroup, "%ld", (long)getpid()) < 1 || fclose(cgroup) != 0) return 68;

    unsetenv("CRONTAB_UI_AGENT_CGROUP_ROOT");
    if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 69;
    if (chdir(argv[2]) != 0) return 69;
    execve(argv[3], &argv[3], environ);
    fprintf(stderr, "execve failed: %s\n", strerror(errno));
    return 70;
}
