#!/bin/bash
# The .rpm's post-install script (electron-builder.config.ts, rpm). rpm runs it
# as root after an install and after an upgrade.
#
# It's electron-builder 26.18's templates/linux/after-install.tpl (in
# app-builder-lib) with Chord's names filled in and one change: it leaves
# chrome-sandbox alone. The package installs chrome-sandbox setuid root (4755).
# electron-builder's script makes it 0755 whenever user namespaces work at
# install time, and Chromium's sandbox then stops working if they're turned
# off later. When electron-builder changes its script, compare and update this
# one (apps/desktop/test/unit/rpm.test.ts checks).
#
# Names are written out, not templated: fpm also runs this file as the upgrade
# script, and electron-builder fills in templates only for the install script.
#
# electron-builder's lines stay as they are, old test syntax included:
# shellcheck disable=SC2006,SC2166

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/chord' -a -e '/usr/bin/chord' -a "`readlink '/usr/bin/chord'`" != '/etc/alternatives/chord' ]; then
        rm -f '/usr/bin/chord'
    fi
    update-alternatives --install '/usr/bin/chord' 'chord' '/opt/Chord/chord' 100 || ln -sf '/opt/Chord/chord' '/usr/bin/chord'
else
    ln -sf '/opt/Chord/chord' '/usr/bin/chord'
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/Chord/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/chord'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
