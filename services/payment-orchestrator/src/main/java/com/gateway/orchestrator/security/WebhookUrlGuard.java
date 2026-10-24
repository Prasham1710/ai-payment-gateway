package com.gateway.orchestrator.security;

import com.gateway.orchestrator.config.GatewayProperties;
import org.springframework.stereotype.Component;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Stops merchants from pointing webhooks at the gateway's own network (SSRF): loopback, private,
 * link-local (cloud metadata), carrier-grade NAT and other non-public addresses are refused unless
 * {@code gateway.webhooks.allow-private-network} is on. Checked when an endpoint is registered and
 * again before every delivery, since DNS answers can change. DNS lookups run on a small pool with
 * a deadline, so a slow nameserver cannot hold a request or sender thread.
 */
@Component
public class WebhookUrlGuard {

    private final boolean allowPrivateNetwork;
    private final Duration lookupTimeout;
    private final ExecutorService resolver;

    public WebhookUrlGuard(GatewayProperties properties) {
        this.allowPrivateNetwork = properties.getWebhooks().isAllowPrivateNetwork();
        this.lookupTimeout = properties.getWebhooks().getTimeout();
        AtomicInteger threads = new AtomicInteger();
        this.resolver = Executors.newFixedThreadPool(4, task -> {
            Thread thread = new Thread(task, "webhook-dns-" + threads.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        });
    }

    /** Returns why the URL may not be called, or {@code null} if it may. */
    public String rejectionReason(URI uri) {
        if (allowPrivateNetwork) {
            return null;
        }
        String host = uri.getHost();
        if (host == null) {
            return "the URL has no host";
        }
        InetAddress[] addresses;
        CompletableFuture<InetAddress[]> lookup = CompletableFuture.supplyAsync(() -> {
            try {
                return InetAddress.getAllByName(host);
            } catch (UnknownHostException e) {
                return null;
            }
        }, resolver);
        try {
            addresses = lookup.get(lookupTimeout.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            lookup.cancel(true);
            return "the host " + host + " could not be resolved in time";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "the host " + host + " could not be resolved";
        } catch (ExecutionException e) {
            return "the host " + host + " could not be resolved";
        }
        if (addresses == null) {
            return "the host " + host + " could not be resolved";
        }
        for (InetAddress address : addresses) {
            if (isNonPublic(address)) {
                return "the host " + host + " resolves to a non-public address";
            }
        }
        return null;
    }

    static boolean isNonPublic(InetAddress address) {
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                || address.isSiteLocalAddress() || address.isMulticastAddress()) {
            return true;
        }
        byte[] b = address.getAddress();
        if (address instanceof Inet4Address) {
            return isNonPublicIpv4(b[0] & 0xff, b[1] & 0xff, b[2] & 0xff);
        }
        // IPv6: unique local fc00::/7, and IPv4 embedded via NAT64 (64:ff9b::/96) or IPv4-compatible (::/96).
        if ((b[0] & 0xfe) == 0xfc) {
            return true;
        }
        boolean nat64 = (b[0] & 0xff) == 0x00 && (b[1] & 0xff) == 0x64 && (b[2] & 0xff) == 0xff && (b[3] & 0xff) == 0x9b
                && allZero(b, 4, 12);
        boolean ipv4Compatible = allZero(b, 0, 12);
        if (nat64 || ipv4Compatible) {
            return isNonPublicIpv4(b[12] & 0xff, b[13] & 0xff, b[14] & 0xff);
        }
        return false;
    }

    private static boolean isNonPublicIpv4(int b0, int b1, int b2) {
        return b0 == 0 || b0 == 10 || b0 == 127 || b0 >= 224          // this-network, private, loopback, multicast, reserved
                || (b0 == 100 && b1 >= 64 && b1 <= 127)               // carrier-grade NAT
                || (b0 == 169 && b1 == 254)                           // link-local, cloud metadata
                || (b0 == 172 && b1 >= 16 && b1 <= 31)                // private
                || (b0 == 192 && b1 == 168)                           // private
                || (b0 == 192 && b1 == 0 && b2 == 0)                  // IETF protocol assignments
                || (b0 == 198 && (b1 == 18 || b1 == 19));             // benchmarking
    }

    private static boolean allZero(byte[] bytes, int from, int to) {
        for (int i = from; i < to; i++) {
            if (bytes[i] != 0) {
                return false;
            }
        }
        return true;
    }
}
