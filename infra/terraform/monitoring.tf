resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "Bot owner"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  depends_on = [google_project_service.this]
}

locals {
  channels = google_monitoring_notification_channel.email[*].id
}

# The bot logs "heartbeat" every 5 minutes while connected to WhatsApp.
resource "google_logging_metric" "heartbeat" {
  name        = "${var.name}_heartbeat"
  description = "WhatsApp bot heartbeats (one every 5 minutes while connected)."
  filter      = "resource.type=\"gce_instance\" AND \"heartbeat\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.this]
}

# No heartbeat for 20 minutes = the bot is down or disconnected.
resource "google_monitoring_alert_policy" "bot_down" {
  count = var.alert_email == "" ? 0 : 1

  display_name          = "WhatsApp bot is down"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "No heartbeat for 20 minutes"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.heartbeat.name}\" AND resource.type=\"gce_instance\""
      duration = "1200s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    content   = "No heartbeat from the bot for 20 minutes. Check: gcloud compute ssh ${google_compute_instance.bot.name} --zone ${var.zone} --tunnel-through-iap -- sudo journalctl -u whatsapp-bot -n 100"
    mime_type = "text/markdown"
  }
}

# Problems that need a human: logged out of WhatsApp, or another copy is running.
resource "google_monitoring_alert_policy" "bot_needs_attention" {
  count = var.alert_email == "" ? 0 : 1

  display_name          = "WhatsApp bot needs attention"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "Logged out or another copy connected"
    condition_matched_log {
      filter = "resource.type=\"gce_instance\" AND (\"Logged out from WhatsApp\" OR \"code 440\")"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  documentation {
    content   = "Logged out: re-link the bot (see infra/README.md, 'Link WhatsApp'). Code 440: stop the other copy (e.g. on your Mac)."
    mime_type = "text/markdown"
  }
}
