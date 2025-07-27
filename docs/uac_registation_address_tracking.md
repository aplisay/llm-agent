# Kamailio UAC Registration Tracking and Lookup - Step by Step Guide

Kamilio has the ability to initiate registrations to a remote SIP server using the UAC module.
This is super helpful if you are running a SIP proxy and one of your upstreams wants you to register with them rather than the other way around and you want to make this transparent to your UACs.

This is [a great description of how to set this up](https://nickvsnetworking.com/kamailio-bytes-uac-for-remote-user-registration-to-external-sip-server-originating-sip-register/) so I'm not going to replicate that here.

It isn't however easy identify the provider route when a call comes from that remote server. The current implementation of the UAC module assumes that they will always present your local contact in the URI of requests they then send you.

Nearly no PSTN trunk providers will do this as they generally send the called number and their own contact in the call URI. In fact there is often no consistent distingushing information in the headers of the incoming request that allows you to link back to the correct provider in your routing rules. 
Even if there were then it wouldn't be safe to necesarily trust the headers as they can be easily spoofed by a different sender.

The following describes a way to track the IP address of the remote server that you registered with to later lookup the correct user in your routing rules.

It doesn't work in all know topologies. In particluar if incoming calls come from a different IP address to the one that you registsred with, but does cover a lot more cases than the default UAC module `uac_reg_lookup_uri` function on the incoming uri.

## 1. Required Module Configuration

First, ensure you have the necessary modules loaded and configured:

```kamailio
#!ifdef WITH_UAC

# Load required modules
loadmodule "uac.so"
loadmodule "htable.so"

# Configure UAC module parameters
modparam("uac", "reg_active", 0)  # Set to 1 if you want automatic registration
modparam("uac", "reg_contact_addr", REG_CONTACT)  # Your contact address
modparam("uac", "reg_db_url", DBURL)  # Database URL if using DB
modparam("uac", "restore_mode", "auto")  # Auto restore registrations

# Configure shared hash table for UAC registration tracking
modparam("htable", "htable", "uac_reg=>size=8;autoexpire=86400;")

#!endif
```

## 2. Capturing Registration Information

Add this to your `onreply_route` to capture successful registrations:

```kamailio
onreply_route {
#!ifdef WITH_UAC
  // If we have received a 200 OK reply to a REGISTER request, record the IP address it came from in the uac_reg table
  if (is_method("REGISTER") && $rs==200 && $rr=="OK") {
    $var(response_contact) = $(ct{s.before,;}{s.unbracket}{uri.user});
    xlog("L_INFO", "Received ACK for registration. Server IP: $si with contact user $var(response_contact)\n");
    $sht(uac_reg=>ipv4::$si) = $var(response_contact);
  }
#!endif
}
```

## 3. Creating the UAC Lookup Route

Add this route to your configuration:

```kamailio
route[UAC] {
#!ifdef WITH_UAC
  // Requests from trunks that we have registered to as a UAC can be hard to identify
  // so we look up the IP address of the requestor against the IP address we registered to.
  // See the onreply_route for the registration IP tracking setup on registrations.
  //
  // If we have a registered user, we can then route the request based on the user permissions.
  $var(uac_reg) = $sht(uac_reg=>ipv4::$si);
  xlog("L_DEBUG", "trying to lookup $si for $ru in uac_reg $var(uac_reg)\n");
  if ($var(uac_reg)!=0 && uac_reg_lookup($var(uac_reg), "$ru")) {
    xlog("L_INFO", "found $si as account $ru\n");
    lookup("location");
  }
  return;
#!endif
}
```

## 4. Integrating with Main Request Route

Add the UAC route to your main request handling:

```kamailio
request_route {
    # ... existing initial checks ...
    
    # Add UAC check before authentication
    route(UAC);
    
    # ... rest of your routing logic ...
}
```

To test this, you will need to setup a registration to a remote registrar. Again, see [this description](https://nickvsnetworking.com/kamailio-bytes-uac-for-remote-user-registration-to-external-sip-server-originating-sip-register/). 
Once you have done that and sucessufully registered, you should find that $ru is transformed by the `route(UAC)` to the correct `uac_reg` user.

## Enhancements

The above is a good start, but there are probably a few enhancements that can be made to make it more robust.

### Expiry

The above has a flat 24hrs expiry on the IP address mapping in the htable. If your UAC registration expiry is less than this then it will work fine, but it does mean that you will accept inbound calls from the remote server for up to 24hrs after your registration has expired.
A better approach would be to use the UAC registration expiry as the expiry time for the IP address mapping in the htable, maybe the `uac_reg_lookup` call pays attention to the current status in flags and won't return a stale entry but I havent checked.

### Multiple Kamailio Instances

If you have multiple Kamailio instances and are registering a load balanced common contact, then you will need to setup the htable to share the `uac_reg` lookup table via a database between the instances. This is a little complicated (distributed caches are fun) and in any case you also probably have the issue of figuring out which instance will initiate the uac register.