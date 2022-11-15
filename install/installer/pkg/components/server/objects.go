// Copyright (c) 2021 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package server

import (
	"github.com/gitpod-io/gitpod/common-go/baseserver"
	"github.com/gitpod-io/gitpod/installer/pkg/common"
	"k8s.io/apimachinery/pkg/runtime"
)

var Objects = common.CompositeRenderFunc(
	configmap,
	deployment,
	networkpolicy,
	func(ctx *common.RenderContext) ([]runtime.Object, error) {
		return Role(ctx, Component)
	},
	rolebinding,
	common.GenerateService(Component, []common.ServicePort{
		{
			Name:          ContainerPortName,
			ContainerPort: ContainerPort,
			ServicePort:   ServicePort,
		},
		{
			Name:          baseserver.BuiltinMetricsPortName,
			ContainerPort: baseserver.BuiltinMetricsPort,
			ServicePort:   baseserver.BuiltinMetricsPort,
		},
		{
			Name:          InstallationAdminName,
			ContainerPort: InstallationAdminPort,
			ServicePort:   InstallationAdminPort,
		},
		{
			Name:          DebugPortName,
			ContainerPort: baseserver.BuiltinDebugPort,
			ServicePort:   baseserver.BuiltinDebugPort,
		},
		{
			Name:          DebugNodePortName,
			ContainerPort: common.DebugNodePort,
			ServicePort:   common.DebugNodePort,
		},
	}),
	common.DefaultServiceAccount(Component),
)
